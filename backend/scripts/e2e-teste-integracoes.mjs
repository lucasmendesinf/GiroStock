// e2e do MODO TESTE com iFood e WhatsApp simulados dentro do servidor (sem rede, sem conta de teste, nada sai de verdade):
// conectar o iFood com um clique, gerar pedidos de teste, cliente cancelando, cardapio, entregador que anda sozinho,
// WhatsApp (avisos, campanha com cupom, SAIR) e o isolamento total da producao.
// Precisa: servidor com DATABASE_URL_TESTE. npm run test:e2e:teste-integracoes
import 'dotenv/config';
import pg from 'pg';

const B = process.env.API_URL || 'http://localhost:3000';
const prod = new pg.Client({ connectionString: process.env.DATABASE_URL });
const teste = new pg.Client({ connectionString: process.env.DATABASE_URL_TESTE });
await prod.connect();
await teste.connect();
let pass = 0; let fail = 0;
const check = (n, c, i) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALHA ${n} -> ${String(JSON.stringify(i)).slice(0, 400)}`); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, rota, body, tok) {
  const res = await fetch(B + '/api' + rota, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { s: res.status, j };
}
async function ate(fn, ms = 20000) { const fim = Date.now() + ms; while (Date.now() < fim) { const r = await fn(); if (r) return r; await espera(500); } return null; }

const A = (await api('POST', '/auth/login', { email: 'admin@girostock.local', senha: 'admin123' })).j.token;
const empresa = (await prod.query(`SELECT tenant_id FROM users WHERE email = 'admin@girostock.local'`)).rows[0].tenant_id;
await prod.query(`UPDATE users SET permissoes = COALESCE(permissoes, '{}'::jsonb) || '{"ModoTeste": true}' WHERE email = 'admin@girostock.local'`);
await prod.query(`UPDATE tenants SET recursos = COALESCE(recursos, '{}'::jsonb) || '{"pedidos": true, "delivery_apps": true, "whatsapp": true, "clientes": true}' WHERE id = $1`, [empresa]);
const contarProd = async () => (await prod.query(
  `SELECT (SELECT count(*) FROM integracoes_delivery WHERE tenant_id = $1)::int AS integ, (SELECT count(*) FROM whatsapp_contas WHERE tenant_id = $1)::int AS wa,
          (SELECT count(*) FROM orders WHERE tenant_id = $1)::int AS pedidos, (SELECT count(*) FROM entregas_ifood WHERE tenant_id = $1)::int AS entregas`, [empresa])).rows[0];
const prodAntes = await contarProd();

console.log('\n# 1. Entrar no modo teste');
let mt = await api('POST', '/auth/modo-teste', { ativo: true }, A);
if (mt.s === 409 && mt.j.precisa_copia) mt = await api('POST', '/auth/modo-teste', { ativo: true, confirmar_copia: true, anonimizar: false }, A);
check('administrador entra no modo teste', mt.s === 200 && mt.j.token, mt.j);
const T = mt.j.token;
const L = Object.fromEntries((await api('GET', '/locations', null, T)).j.map((l) => [l.nome, l.id]));
const lst = await api('GET', '/integracoes', null, T);
check('integrações liberadas no modo teste; iFood "configurado" (simulado)', lst.s === 200 && lst.j.ifood_configurado === true, lst.j);
check('99Food continua bloqueada no modo teste', (await api('POST', '/integracoes/99food/conectar', { location_id: L.Lanchonete }, T)).s === 409);
check('conectar-teste fora do modo teste -> 409', (await api('POST', '/integracoes/ifood/conectar-teste', { location_id: L.Lanchonete }, A)).s === 409);

console.log('\n# 2. iFood de teste: conectar com um clique e receber pedidos');
const con = await api('POST', '/integracoes/ifood/conectar-teste', { location_id: L.Lanchonete }, T);
check('conectar com um clique: conectado na loja de teste', con.s === 200 && con.j.status === 'conectado' && /^teste-/.test(con.j.merchant_id) && /teste/.test(con.j.merchant_nome), con.j);
const INTEG = (await api('GET', '/integracoes', null, T)).j.integracoes.find((i) => i.plataforma === 'ifood' && i.location_id === L.Lanchonete);
check('conexão fica só no banco de teste', !!INTEG && !(await prod.query(`SELECT 1 FROM integracoes_delivery WHERE merchant_id = $1`, [con.j.merchant_id])).rows.length);
const P = (await api('GET', '/products', null, T)).j.find((p) => p.codigo_interno === 'PRD-0001');
await api('POST', '/stock-movements', { product_id: P.id, tipo: 'entrada', quantidade: 50, location_destino_id: L.Lanchonete, motivo: 'e2e teste integracoes' }, T);
const env = await api('POST', `/integracoes/${INTEG.id}/cardapio/enviar`, { product_ids: [P.id] }, T);
check('enviar cardápio ao iFood de teste', env.s === 200 && env.j.enviados === 1, env.j);
const g1 = await api('POST', `/integracoes/${INTEG.id}/teste/pedido`, { itens: 'cardapio', entrega: 'ifood', pagamento: 'online' }, T);
check('gerar pedido de teste: entra na hora em Pedidos', g1.s === 201 && g1.j.order_id && g1.j.situacao === 'importado', g1.j);
const o1 = (await api('GET', `/orders/${g1.j.order_id}`, null, T)).j;
check('pedido do iFood de teste com os itens do cardápio', o1.origem === 'ifood' && o1.itens.some((i) => i.product_id === P.id), o1);
check('avançar o pedido do iFood (o iFood simulado aceita)', (await api('POST', `/orders/${g1.j.order_id}/status`, { para: 'em_preparo' }, T)).s === 200);
const g2 = await api('POST', `/integracoes/${INTEG.id}/teste/pedido`, { itens: 'desconhecido', entrega: 'loja', pagamento: 'dinheiro' }, T);
check('item desconhecido: fica aguardando vínculo', g2.s === 201 && g2.j.situacao === 'aguardando_vinculo', g2.j);
const g3 = await api('POST', `/integracoes/${INTEG.id}/teste/pedido`, { itens: 'cardapio', entrega: 'retirada', pagamento: 'cartao' }, T);
const canc = await api('POST', `/integracoes/teste/pedidos/${g3.j.order_id}/cliente/cancelar`, {}, T);
check('cliente cancela no iFood de teste: o pedido é cancelado aqui', canc.s === 200 && (await api('GET', `/orders/${g3.j.order_id}`, null, T)).j.status === 'cancelado', canc.j);
check('nenhum pedido novo na produção', (await contarProd()).pedidos === prodAntes.pedidos);

console.log('\n# 3. Entregador do iFood de teste (anda sozinho no mapa)');
const PE = (await api('POST', '/orders', { location_id: L.Lanchonete, origem: 'telefone', tipo: 'entrega', cliente_nome: 'Cliente Teste', cliente_telefone: '(41) 99876-5432',
  endereco: 'Rua XV de Novembro, 700 - Centro, Curitiba/PR', taxa_entrega: 7, itens: [{ product_id: P.id, quantidade: 1 }] }, T)).j;
const end = { cep: '80020310', logradouro: 'Rua XV de Novembro', numero: '700', bairro: 'Centro', cidade: 'Curitiba', uf: 'PR' };
const cot = await api('POST', `/integracoes/entregas/pedidos/${PE.id}/cotar`, { endereco: end }, T);
check('cotação no modo teste (sem localizar o endereço: ponto perto da loja)', cot.s === 200 && cot.j.valor > 0 && cot.j.origem_coordenadas === 'teste', cot.j);
const ch = await api('POST', `/integracoes/entregas/pedidos/${PE.id}/chamar`, { endereco: end, cotacao_id: cot.j.cotacao_id, cotacao: cot.j, pagamento: { tipo: 'dinheiro', troco_para: 50 } }, T);
check('chamar entregador de teste', ch.s === 201 && ch.j.status === 'solicitada', ch.j);
const st = async () => (await api('GET', `/orders/${PE.id}`, null, T)).j;
check('o entregador é alocado sozinho (ciclo do modo teste)', !!(await ate(async () => (await st()).entrega_ifood?.status === 'alocado', 25000)), (await st()).entrega_ifood);
const r1 = (await api('GET', `/integracoes/entregas/pedidos/${PE.id}/rastreio`, null, T)).j;
check('posição do entregador no mapa', r1.entregador && typeof r1.entregador.lat === 'number', r1);
for (let i = 0; i < 3; i++) await api('POST', `/integracoes/entregas/pedidos/${PE.id}/teste/avancar`, {}, T); // a caminho, na loja, coletou
check('avançar: coletou -> pedido em "Saiu p/ entrega" com código do cliente', !!(await ate(async () => { const o = await st(); return o.status === 'saiu_entrega' && o.entrega_ifood.status === 'em_rota' && o.entrega_ifood.codigo_entrega === '5432'; })), (await st()).entrega_ifood);
await espera(3500);
const r2 = (await api('GET', `/integracoes/entregas/pedidos/${PE.id}/rastreio`, null, T)).j;
check('o entregador "anda" do ponto da loja para o cliente', r2.entregador && (r2.entregador.lat !== r1.entregador.lat || r2.entregador.lng !== r1.entregador.lng), [r1.entregador, r2.entregador]);
await api('POST', `/integracoes/entregas/pedidos/${PE.id}/teste/avancar`, {}, T);
await api('POST', `/integracoes/entregas/pedidos/${PE.id}/teste/avancar`, {}, T);
check('entrega concluída', !!(await ate(async () => (await st()).entrega_ifood?.status === 'entregue')));
check('avançar fora do modo teste -> 409', (await api('POST', `/integracoes/entregas/pedidos/${PE.id}/teste/avancar`, {}, A)).s === 409);
check('nenhuma entrega na produção', (await contarProd()).entregas === prodAntes.entregas);

console.log('\n# 4. WhatsApp de teste (mensagens não saem: ficam na caixa de teste)');
const w0 = (await api('GET', '/whatsapp', null, T)).j;
check('WhatsApp no modo teste: simulador', w0.meta && w0.meta.simulador === true, w0.meta);
const wc = await api('POST', '/whatsapp/conectar', { code: 'code-simulador', waba_id: '1110001', phone_number_id: '2229999' }, T);
check('conectar o WhatsApp de teste', wc.s === 200 && wc.j.conectado, wc.j);
await api('POST', '/whatsapp/modelos/conferir', {}, T);
const PW = (await api('POST', '/orders', { location_id: L.Lanchonete, origem: 'whatsapp', tipo: 'retirada', cliente_nome: 'Bia Teste', cliente_telefone: '(41) 98111-7777', itens: [{ product_id: P.id, quantidade: 1 }] }, T)).j;
const caixa = async () => (await api('GET', '/whatsapp/teste/caixa', null, T)).j;
const av = await ate(async () => (await caixa()).find((m) => m.para === '5541981117777' && /Recebemos o seu pedido nº/.test(m.texto || '')), 25000);
check('aviso "pedido recebido" aparece na caixa de teste com o texto que o cliente veria', !!av, await caixa());
check('a mensagem passa a "lida" (simulado)', !!(await ate(async () => (await api('GET', `/whatsapp/mensagens?order_id=${PW.id}`, null, T)).j.some((m) => m.situacao === 'lida'), 15000)));
const cli = (await teste.query(`INSERT INTO customers (tenant_id, nome, telefone, aceita_mensagens, consentimento_em) VALUES ($1, 'Carla Teste', '41981118888', true, now()) RETURNING id`, [empresa])).rows[0].id;
const cmp = await api('POST', '/whatsapp/campanhas', { nome: 'Teste volta', modelo: 'volta', customer_ids: [cli], cupom: { tipo: 'percentual', valor: 10, validade_dias: 7 } }, T);
check('campanha com cupom no modo teste', cmp.s === 201 && cmp.j.total === 1, cmp.j);
const mk = await ate(async () => (await caixa()).find((m) => m.para === '5541981118888' && m.categoria === 'MARKETING'), 25000);
check('mensagem da campanha na caixa: cupom individual e rodapé SAIR', mk && /VOLTA-[A-Z0-9]{5}/.test(mk.texto) && /SAIR/.test(mk.rodape), mk);
const sair = await api('POST', '/whatsapp/teste/responder', { telefone: '41981118888', texto: 'SAIR' }, T);
check('simular o cliente respondendo SAIR: perde o consentimento (no teste)', sair.s === 200 && sair.j.clientes_descadastrados === 1 && (await teste.query(`SELECT aceita_mensagens FROM customers WHERE id = $1`, [cli])).rows[0].aceita_mensagens === false, sair.j);
check('confirmação do SAIR aparece na caixa', (await caixa()).some((m) => m.para === '5541981118888' && /não vai mais receber ofertas/.test(m.texto || '')));
check('caixa de teste fora do modo teste -> 409', (await api('GET', '/whatsapp/teste/caixa', null, A)).s === 409);

console.log('\n# 5. Produção intacta');
const prodDepois = await contarProd();
check('produção: nenhuma conexão, WhatsApp, pedido ou entrega a mais', JSON.stringify(prodDepois) === JSON.stringify(prodAntes), [prodAntes, prodDepois]);
check('produção: integrações continuam fechadas para quem não está no teste', (await api('GET', '/integracoes', null, A)).j.integracoes.every((i) => !/^teste-/.test(i.merchant_id || '')));
await api('POST', '/auth/modo-teste', { ativo: false }, T);

console.log(`\n${pass} ok, ${fail} falha(s)`);
await prod.end(); await teste.end();
process.exit(fail ? 1 : 0);
