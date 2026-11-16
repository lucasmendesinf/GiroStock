// Acoes que so existem no MODO TESTE (iFood e WhatsApp simulados): conectar o iFood com um clique, gerar pedido de teste,
// simular o cliente (cancelar / pedir cancelamento), avancar o entregador e ver as mensagens do WhatsApp que "teriam saido".
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const teste = require('./testeSimulado');

const exigirTeste = (user) => { if (!user.modoTeste || !teste.ativo()) throw new HttpError(409, 'disponível só no modo teste'); };
const PONTO_PADRAO = { lat: -23.55052, lng: -46.633308 };

// Ponto da loja (o da loja virtual, se marcado) para o entregador simulado e a cotacao.
async function pontoDaLoja(tenantId) {
  try {
    const r = (await pool.query(`SELECT loja_lat, loja_lng FROM lv_lojas WHERE tenant_id = $1`, [tenantId])).rows[0];
    if (r && r.loja_lat !== null && r.loja_lng !== null) return { lat: Number(r.loja_lat), lng: Number(r.loja_lng) };
  } catch { /* sem loja virtual */ }
  return { ...PONTO_PADRAO };
}

// ---------- iFood ----------
async function conectarIfood(user, locationId) {
  exigirTeste(user);
  if (!isUuid(locationId)) throw new HttpError(400, 'loja inválida');
  const ifood = require('./ifood/servico');
  const loja = (await pool.query(`SELECT id, nome FROM locations WHERE id = $1 AND tenant_id = $2`, [locationId, user.tenantId])).rows[0];
  if (!loja) throw new HttpError(404, 'loja não encontrada');
  const ini = await ifood.iniciarConexao(user, locationId);
  const sim = teste.simIfood();
  const merchantId = `teste-${locationId.slice(0, 8)}`;
  sim.garantirLoja(merchantId);
  const l = sim.LOJAS.find((x) => x.id === merchantId);
  l.name = `${loja.nome} (iFood de teste)`;
  l.ponto = await pontoDaLoja(user.tenantId);
  const au = await sim.atender('GET', `/_sim/autorizar?userCode=${encodeURIComponent(ini.codigo)}&merchantId=${merchantId}`, {}, {});
  return ifood.concluirConexao(user, ini.id, au.corpo.authorizationCode);
}

async function conexao(user, id) {
  const integ = (await pool.query(`SELECT * FROM integracoes_delivery WHERE id = $1 AND tenant_id = $2 AND plataforma = 'ifood'`, [id, user.tenantId])).rows[0];
  if (!integ) throw new HttpError(404, 'conexão não encontrada');
  if (integ.status !== 'conectado') throw new HttpError(409, 'conecte o iFood de teste nesta loja primeiro');
  const sim = teste.simIfood();
  sim.garantirLoja(integ.merchant_id);
  const l = sim.LOJAS.find((x) => x.id === integ.merchant_id);
  if (!l.ponto) l.ponto = await pontoDaLoja(user.tenantId);
  return integ;
}

const NOMES = ['Maria Teste', 'João Teste', 'Ana Teste', 'Pedro Teste', 'Carla Teste'];
// b: { itens: 'cardapio' | 'desconhecido', entrega: 'ifood' | 'loja' | 'retirada', pagamento: 'online' | 'dinheiro' | 'cartao' }
async function gerarPedido(user, integId, b = {}) {
  exigirTeste(user);
  const integ = await conexao(user, integId);
  let itens;
  if (b.itens === 'desconhecido') {
    itens = [{ nome: `Item de teste ${Math.floor(Math.random() * 900 + 100)}`, codigo: null, quantidade: 1, preco: 19.9 }];
  } else {
    // produtos com codigo PDV (os enviados ao cardapio do iFood primeiro), preco da loja
    const prods = (await pool.query(
      `SELECT p.nome, COALESCE(NULLIF(p.codigo_ifood, ''), p.codigo_interno) AS codigo, COALESCE(ic.preco, p.preco_venda) AS preco
       FROM products p LEFT JOIN ifood_cardapio ic ON ic.product_id = p.id AND ic.integracao_id = $2 AND ic.enviado_em IS NOT NULL
       WHERE p.tenant_id = $1 AND p.ativo AND p.preco_venda > 0 AND COALESCE(NULLIF(p.codigo_ifood, ''), p.codigo_interno) IS NOT NULL
       ORDER BY (ic.product_id IS NOT NULL) DESC, random() LIMIT 2`, [user.tenantId, integ.id]
    )).rows;
    if (!prods.length) throw new HttpError(409, 'cadastre um produto com preço para gerar o pedido de teste (ou use "item desconhecido")');
    itens = prods.map((p, i) => ({ nome: p.nome, codigo: String(p.codigo).toUpperCase(), quantidade: i === 0 ? 2 : 1, preco: Number(p.preco) }));
  }
  const entrega = ['ifood', 'loja', 'retirada'].includes(b.entrega) ? b.entrega : 'ifood';
  const pag = ['online', 'dinheiro', 'cartao'].includes(b.pagamento) ? b.pagamento : 'online';
  const sim = teste.simIfood();
  const p = sim.novoPedido({
    merchantId: integ.merchant_id, itens, cliente: NOMES[Math.floor(Math.random() * NOMES.length)],
    tipo: entrega === 'retirada' ? 'TAKEOUT' : 'DELIVERY', entrega_ifood: entrega === 'ifood', pago_online: pag === 'online',
    metodo: pag === 'cartao' ? 'CREDIT' : 'CASH', troco_para: pag === 'dinheiro' ? 100 : undefined, taxa: entrega === 'retirada' ? 0 : 6.99,
  });
  // busca na hora (sem esperar o ciclo)
  await require('./ifood/servico').sincronizar(integ);
  const o = (await pool.query(`SELECT pe.order_id, pe.situacao FROM pedidos_externos pe WHERE pe.plataforma = 'ifood' AND pe.externo_id = $1`, [p.id])).rows[0];
  return { externo_id: p.id, codigo: p.displayId, order_id: o ? o.order_id : null, situacao: o ? o.situacao : null };
}

// Cliente do iFood: cancela antes do aceite ("cancelar") ou pede cancelamento depois ("disputa").
async function acaoCliente(user, orderId, acao) {
  exigirTeste(user);
  if (!['cancelar', 'disputa'].includes(acao)) throw new HttpError(400, 'ação inválida');
  const pe = (await pool.query(
    `SELECT pe.*, i.id AS integ_id FROM pedidos_externos pe JOIN integracoes_delivery i ON i.id = pe.integracao_id WHERE pe.order_id = $1 AND pe.tenant_id = $2 AND pe.plataforma = 'ifood'`,
    [orderId, user.tenantId]
  )).rows[0];
  if (!pe) throw new HttpError(404, 'pedido do iFood não encontrado');
  const integ = await conexao(user, pe.integ_id);
  const r = await teste.simIfood().atender('POST', `/_sim/pedidos/${pe.externo_id}/${acao === 'cancelar' ? 'cancelar-cliente' : 'disputa'}`, {}, {});
  if (r.status >= 400) throw new HttpError(409, 'este pedido de teste não existe mais no simulador (o servidor foi reiniciado): gere outro');
  await require('./ifood/servico').sincronizar(integ);
  return { ok: true };
}

// Entregador simulado: proximo passo agora (sem esperar o tempo).
async function avancarEntregador(user, orderId) {
  exigirTeste(user);
  const e = (await pool.query(`SELECT ei.* FROM entregas_ifood ei JOIN orders o ON o.id = ei.order_id WHERE ei.order_id = $1 AND o.tenant_id = $2 ORDER BY ei.criado_em DESC LIMIT 1`, [orderId, user.tenantId])).rows[0];
  if (!e) throw new HttpError(404, 'este pedido não tem entregador do iFood');
  const status = teste.simIfood().avancarEntrega(e.ifood_pedido_id);
  if (status === null) throw new HttpError(409, 'esta entrega de teste não existe mais no simulador (o servidor foi reiniciado): chame outro entregador');
  const integ = await conexao(user, e.integracao_id);
  await require('./ifood/servico').sincronizar(integ);
  return { ok: true };
}

// ---------- WhatsApp ----------
async function caixaWhatsapp(user) {
  exigirTeste(user);
  const c = (await pool.query(`SELECT phone_number_id FROM whatsapp_contas WHERE tenant_id = $1`, [user.tenantId])).rows[0];
  if (!c) return [];
  return teste.simWhatsapp().enviadas.filter((m) => m.de === c.phone_number_id).slice(-100).reverse()
    .map((m) => ({ wamid: m.wamid, para: m.to, modelo: m.modelo || null, categoria: m.categoria || (m.modelo ? null : 'TEXTO'), texto: m.texto, rodape: m.rodape || null, em: m.em }));
}

async function responderWhatsapp(user, b = {}) {
  exigirTeste(user);
  const c = (await pool.query(`SELECT phone_number_id FROM whatsapp_contas WHERE tenant_id = $1 AND status = 'conectado'`, [user.tenantId])).rows[0];
  if (!c) throw new HttpError(409, 'conecte o WhatsApp de teste primeiro');
  const tel = String(b.telefone || '').replace(/\D/g, '');
  if (tel.length < 10) throw new HttpError(400, 'informe o celular do cliente (com DDD)');
  const texto = String(b.texto || '').trim().slice(0, 200);
  if (!texto) throw new HttpError(400, 'escreva a resposta do cliente');
  const wa = require('./whatsapp');
  const de = tel.length <= 11 ? `55${tel}` : tel;
  // o mesmo caminho do webhook da Meta: SAIR tira o consentimento; outra mensagem pode ganhar a resposta automatica
  const r = await wa.receberMensagem(c.phone_number_id, de, texto);
  return { ok: true, sair: r.sair, clientes_descadastrados: r.removidos || 0, resposta: r.resposta || null };
}

module.exports = { conectarIfood, gerarPedido, acaoCliente, avancarEntregador, caixaWhatsapp, responderWhatsapp, pontoDaLoja };
