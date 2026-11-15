// iFood Entrega Facil (Sob Demanda, modulo Shipping): chamar um entregador do iFood para um pedido de OUTRO canal
// (balcao, telefone, WhatsApp, cardapio digital, loja virtual). developer.ifood.com.br > Shipping > Pedidos fora da plataforma.
// Fluxo: cotacao (coordenadas do endereco) -> registrar o pedido no iFood (cliente, endereco, itens, pagamento) -> o iFood
// aloca o entregador (o endereco e as coordenadas vao para o app dele) -> eventos (polling, o mesmo dos pedidos) ->
// rastreio (posicao do entregador). O cliente acompanha pelo link do iFood (trackingUrl).
// Pre-requisitos da loja: iFood conectado na loja, servico Sob Demanda contratado no Portal do Parceiro, endereco ate ~10 km.
const comum = require('../comum');
const api = require('./api');
const { HttpError } = require('../../utils/http');
const { ErroPlataforma } = require('../http');
const { logAudit } = require('../../utils/audit');
const { assertLocationAccess } = require('../../utils/access');
const geocodificacao = require('../../services/geocodificacao');
const { requisicao } = require('../http');

const db = () => comum.db();
const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const corta = (v, n) => String(v || '').trim().slice(0, n);
const ATIVAS = ['solicitada', 'buscando', 'alocado', 'indo_loja', 'na_loja', 'em_rota', 'no_destino'];
const ORDEM = { solicitada: 0, buscando: 1, alocado: 2, indo_loja: 3, na_loja: 4, em_rota: 5, no_destino: 6, entregue: 7 };

// Motivos que o iFood devolve (cotacao/registro) em portugues para a tela.
const ERROS = {
  BadRequestMerchant: 'a loja está indisponível no iFood (confira o status no Portal do Parceiro)',
  DeliveryDistanceTooHigh: 'o endereço está longe demais para o entregador do iFood (limite de cerca de 10 km)',
  OffOpeningHours: 'fora do horário de operação do iFood para esta loja',
  OriginNotFound: 'a loja não está cadastrada na área de entrega do iFood',
  ServiceAreaMismatch: 'o endereço está fora da área atendida pelo iFood',
  HighDemand: 'os entregadores do iFood estão todos ocupados agora: tente de novo em alguns minutos',
  MerchantStatusAvailability: 'a conta da loja no iFood tem pendências: fale com o suporte do iFood',
  InvalidPaymentMethods: 'forma de pagamento não aceita pelo entregador do iFood',
  PaymentMethodNotFound: 'forma de pagamento não aceita pelo entregador do iFood',
  PaymentTotalInvalid: 'o valor do pagamento não bate com o total do pedido',
  NRELimitExceeded: 'limite de entregadores do iFood ao mesmo tempo atingido: aguarde uma entrega terminar',
  UnavailableFleet: 'sem entregadores do iFood disponíveis agora: tente mais tarde',
  MerchantEasyDeliveryDisabled: 'o serviço Entrega Fácil (Sob Demanda) não está contratado para esta loja: ative no Portal do Parceiro → Serviços',
  BadRequestCustomer: 'nome ou telefone do cliente inválido para o iFood',
  BadRequest: 'dados recusados pelo iFood: confira o endereço e o telefone',
};
function erroDoIfood(err) {
  if (!(err instanceof ErroPlataforma)) return err;
  const c = err.corpo || {};
  const codigo = (c.error && c.error.code) || c.code || '';
  if (err.status === 401 || err.status === 403) return new HttpError(409, 'o iFood recusou o acesso à Entrega Fácil: confira se o app tem o módulo Shipping e se o serviço está contratado');
  if (ERROS[codigo]) return new HttpError(422, `iFood: ${ERROS[codigo]}`);
  return new HttpError(err.status >= 500 ? 502 : 422, err.message);
}

// ---------- endereco ----------
// Texto do pedido ("Rua X, 100 - Apto 2 - Bairro, Cidade/UF (Ref.: ...)") em campos (melhor esforco; a tela confirma).
function enderecoDoTexto(texto) {
  const e = { cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', referencia: '' };
  let t = String(texto || '').trim();
  const ref = t.match(/\(Ref\.?:\s*([^)]*)\)\s*$/i);
  if (ref) { e.referencia = ref[1].trim(); t = t.slice(0, ref.index).trim(); }
  const cep = t.match(/\b(\d{5})-?(\d{3})\b/);
  if (cep) { e.cep = cep[1] + cep[2]; t = t.replace(cep[0], '').replace(/\s*[-,]\s*$/, '').trim(); }
  const partes = t.split(/\s+-\s+/);
  const primeira = partes.shift() || '';
  const m = primeira.match(/^(.*?),\s*(\S+)$/);
  if (m) { e.logradouro = m[1].trim(); e.numero = m[2].trim(); } else e.logradouro = primeira.trim();
  const ultima = partes.length ? partes.pop() : '';
  if (partes.length) e.complemento = partes.join(' - ');
  const cid = ultima.match(/^(.*?),\s*([^,/]+?)(?:\/([A-Za-z]{2}))?$/);
  if (cid) { e.bairro = cid[1].trim(); e.cidade = cid[2].trim(); e.uf = (cid[3] || '').toUpperCase(); } else e.bairro = ultima.trim();
  return e;
}

function validarEndereco(b) {
  const e = {
    cep: String(b.cep || '').replace(/\D/g, ''), logradouro: corta(b.logradouro, 50), numero: corta(b.numero, 10) || 'S/N',
    complemento: corta(b.complemento, 50), bairro: corta(b.bairro, 50), cidade: corta(b.cidade, 50), uf: corta(b.uf, 2).toUpperCase(), referencia: corta(b.referencia, 70),
  };
  if (e.cep.length !== 8) throw new HttpError(400, 'informe o CEP da entrega (8 dígitos)');
  if (e.logradouro.length < 3) throw new HttpError(400, 'informe a rua da entrega');
  if (e.bairro.length < 2) throw new HttpError(400, 'informe o bairro da entrega');
  if (e.cidade.length < 2) throw new HttpError(400, 'informe a cidade da entrega');
  if (!/^[A-Z]{2}$/.test(e.uf)) throw new HttpError(400, 'informe a UF da entrega (ex.: SP)');
  return e;
}

// Coordenadas: as que a tela mandou (pino conferido no mapa) ou a localizacao do endereco.
async function coordenadas(e, b) {
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) return { lat, lng, origem: 'pino' };
  const g = await geocodificacao.geocodificar(db(), { cep: e.cep, numero: e.numero, logradouro: e.logradouro, bairro: e.bairro, cidade: e.cidade, uf: e.uf });
  // modo teste (iFood simulado): sem localizar o endereco, usa um ponto a ~2 km da loja (da para arrastar no mapa)
  if (!g.localizado && require('../testeSimulado').ativo() && b.tenantId) {
    const loja = await require('../testeAcoes').pontoDaLoja(b.tenantId);
    return { lat: Number((loja.lat - 0.012).toFixed(6)), lng: Number((loja.lng + 0.011).toFixed(6)), origem: 'teste' };
  }
  if (!g.localizado) {
    const st = geocodificacao.status();
    throw new HttpError(422, st.configurado
      ? 'não foi possível localizar este endereço no mapa: confira o CEP e o número, ou marque o ponto no mapa'
      : 'a localização de endereços não está ligada no servidor (GEOCODER): marque o ponto da entrega no mapa');
  }
  return { lat: g.lat, lng: g.lng, origem: g.origem };
}

// Rua, bairro e cidade pelo CEP (para preencher a tela). Simulado: CEPs de teste; publico: BrasilAPI.
async function buscarCep(cepBruto) {
  const cep = String(cepBruto || '').replace(/\D/g, '');
  if (cep.length !== 8) throw new HttpError(400, 'CEP inválido');
  const st = geocodificacao.status();
  if (st.provedor === 'simulado') {
    const c = geocodificacao.SIMULADO_CEPS[cep];
    if (!c) return { encontrado: false };
    return { encontrado: true, cep, logradouro: 'Rua Teste', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' };
  }
  if (st.provedor !== 'publico' && st.provedor !== 'http') return { encontrado: false };
  try {
    const base = (process.env.GEOCODER_BRASILAPI_URL || 'https://brasilapi.com.br/api/cep/v2').replace(/\/$/, '');
    const r = await requisicao('GET', `${base}/${cep}`, { timeoutMs: 6000, headers: process.env.GEOCODER_USER_AGENT ? { 'user-agent': process.env.GEOCODER_USER_AGENT } : {} });
    if (r.status !== 200 || !r.corpo) return { encontrado: false };
    return { encontrado: true, cep, logradouro: r.corpo.street || '', bairro: r.corpo.neighborhood || '', cidade: r.corpo.city || '', uf: r.corpo.state || '' };
  } catch {
    return { encontrado: false };
  }
}

// ---------- pedido e conexao ----------
async function pedidoDaEntrega(user, orderId, client = db()) {
  const o = (await client.query(
    `SELECT o.*, COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS subtotal_itens
     FROM orders o WHERE o.id = $1 AND o.tenant_id = $2`, [orderId, user.tenantId]
  )).rows[0];
  if (!o) throw new HttpError(404, 'pedido não encontrado');
  assertLocationAccess(user, o.location_id, 'chamar entregador para pedidos desta loja');
  return o;
}

function podeChamar(o) {
  if (o.tipo !== 'entrega') return 'só pedidos de entrega podem chamar o entregador do iFood';
  if (o.origem === 'ifood' || o.origem === '99food') return 'pedido de plataforma: a entrega é da própria plataforma ou da loja';
  if (o.comanda_id) return 'pedido de comanda não tem entrega';
  if (o.lv_fluxo === 'ecommerce') return 'pedido de loja online (envio por transportadora)';
  if (['finalizado', 'cancelado', 'saiu_entrega'].includes(o.status)) return 'o pedido já saiu para a entrega ou foi encerrado';
  return null;
}

async function conexaoDaLoja(tenantId, locationId) {
  return (await db().query(
    `SELECT * FROM integracoes_delivery WHERE tenant_id = $1 AND location_id = $2 AND plataforma = 'ifood' AND status = 'conectado'`, [tenantId, locationId]
  )).rows[0] || null;
}
async function token(integ) { return require('./servico').tokenDa(integ); }

const entregaAtual = async (orderId) => (await db().query(`SELECT * FROM entregas_ifood WHERE order_id = $1 ORDER BY criado_em DESC LIMIT 1`, [orderId])).rows[0] || null;

function publicaEntrega(e) {
  if (!e) return null;
  return {
    id: e.id, status: e.status, ativa: ATIVAS.includes(e.status), valor: e.valor === null ? null : Number(e.valor), distancia_m: e.distancia_m,
    tempo_min: e.tempo_min, tempo_max: e.tempo_max, tracking_url: e.tracking_url, endereco: e.endereco, lat: Number(e.lat), lng: Number(e.lng),
    pagamento: e.pagamento, alocar_em: e.alocar_em, entregador_nome: e.entregador_nome,
    entregador: e.entregador_lat === null ? null : { lat: Number(e.entregador_lat), lng: Number(e.entregador_lng), em: e.rastreio_em },
    previsao_entrega: e.previsao_entrega, codigo_entrega: e.codigo_entrega, erro: e.erro, criado_em: e.criado_em, atualizado_em: e.atualizado_em,
  };
}

// Dados para a tela "Chamar entregador iFood": endereco sugerido, pagamento do pedido e a entrega atual.
async function preparar(user, orderId) {
  const o = await pedidoDaEntrega(user, orderId);
  const integ = await conexaoDaLoja(user.tenantId, o.location_id);
  const ee = o.entrega_endereco || null;
  const sugerido = ee ? { ...enderecoDoTexto(''), ...ee } : enderecoDoTexto(o.endereco);
  const lat = ee && ee.lat != null ? ee.lat : o.entrega_lat !== null ? Number(o.entrega_lat) : null;
  const lng = ee && ee.lng != null ? ee.lng : o.entrega_lng !== null ? Number(o.entrega_lng) : null;
  return {
    pode: !podeChamar(o) && !!integ, motivo: podeChamar(o) || (integ ? null : 'conecte o iFood nesta loja (Lojas & PDVs) para usar os entregadores do iFood'),
    endereco_texto: o.endereco, endereco: { ...sugerido, lat, lng },
    pago: pagoAntes(o), forma_prevista: o.forma_pagamento_prevista, troco_para: o.troco_para === null ? null : Number(o.troco_para),
    total: n2(Number(o.subtotal_itens) + Number(o.taxa_entrega) - Number(o.desconto || 0)),
    telefone: o.cliente_telefone, geocodificador: geocodificacao.status(), mapa: geocodificacao.configMapa(),
    entrega: publicaEntrega(await entregaAtual(o.id)),
  };
}
const pagoAntes = (o) => !!o.pago || (!!o.pagamento_online && o.pagamento_status === 'aprovado');

// ---------- cotacao ----------
async function cotar(user, orderId, b) {
  const o = await pedidoDaEntrega(user, orderId);
  const bloq = podeChamar(o);
  if (bloq) throw new HttpError(409, bloq);
  const integ = await conexaoDaLoja(user.tenantId, o.location_id);
  if (!integ) throw new HttpError(409, 'conecte o iFood nesta loja (Lojas & PDVs) para usar os entregadores do iFood');
  const e = validarEndereco(b.endereco || {});
  const pt = await coordenadas(e, { ...(b.endereco || {}), tenantId: user.tenantId });
  let c;
  try { c = await api.cotarEntrega(await token(integ), integ.merchant_id, pt.lat, pt.lng); } catch (err) { throw erroDoIfood(err); }
  const q = c.quote || {};
  return {
    cotacao_id: c.id, valor: n2(q.netValue !== undefined ? q.netValue : q.grossValue), valor_bruto: n2(q.grossValue), desconto: n2(q.discount),
    distancia_m: c.distance, tempo_min: c.deliveryTime ? Math.round(c.deliveryTime.min / 60) : null, tempo_max: c.deliveryTime ? Math.round(c.deliveryTime.max / 60) : null,
    preparo_sugerido_min: c.preparationTime ? Math.round(c.preparationTime / 60) : null, expira_em: c.expirationAt,
    formas: (c.paymentMethods || []).map((m) => ({ metodo: m.method, bandeira: m.brand || null })),
    lat: pt.lat, lng: pt.lng, origem_coordenadas: pt.origem, endereco: e,
  };
}

// ---------- registrar o pedido no iFood (aloca o entregador) ----------
function telefoneIfood(t) {
  let d = String(t || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  return { countryCode: '55', areaCode: d.slice(0, 2), number: d.slice(2), type: 'CUSTOMER' };
}

async function itensIfood(o) {
  const itens = (await db().query(
    `SELECT oi.id, p.nome, p.codigo_interno, oi.quantidade, oi.preco_unitario, oi.subtotal FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`, [o.id]
  )).rows;
  const desconto = n2(o.desconto);
  const inteiros = itens.every((i) => Number.isInteger(Number(i.quantidade)));
  // Com desconto ou quantidade fracionada (kg), vai um item so com o valor do pedido (a soma precisa bater com o pagamento).
  if (desconto > 0 || !inteiros) {
    const v = n2(Number(o.subtotal_itens) - desconto);
    return [{ id: o.id, name: corta(`Pedido nº ${o.numero} (${itens.length} ${itens.length === 1 ? 'item' : 'itens'})`, 50), quantity: 1, unitPrice: v, price: v, optionsPrice: 0, totalPrice: v }];
  }
  return itens.map((i) => {
    const q = Number(i.quantidade);
    const total = n2(i.subtotal);
    const unit = n2(total / q);
    return { id: i.id, name: corta(i.nome, 50), externalCode: i.codigo_interno || undefined, quantity: q, unitPrice: unit, price: total, optionsPrice: 0, totalPrice: total };
  });
}

async function solicitar(user, orderId, b) {
  const o = await pedidoDaEntrega(user, orderId);
  const bloq = podeChamar(o);
  if (bloq) throw new HttpError(409, bloq);
  const ja = await entregaAtual(o.id);
  if (ja && ATIVAS.includes(ja.status)) throw new HttpError(409, 'este pedido já tem um entregador do iFood a caminho');
  const integ = await conexaoDaLoja(user.tenantId, o.location_id);
  if (!integ) throw new HttpError(409, 'conecte o iFood nesta loja (Lojas & PDVs) para usar os entregadores do iFood');
  if (!b.cotacao_id) throw new HttpError(400, 'faça a cotação antes de chamar o entregador');
  const e = validarEndereco(b.endereco || {});
  const pt = await coordenadas(e, { ...(b.endereco || {}), tenantId: user.tenantId });
  const tel = telefoneIfood(o.cliente_telefone);
  if (!tel) throw new HttpError(400, 'informe o celular do cliente no pedido (com DDD): o entregador do iFood pede ao cliente os 4 últimos dígitos para entregar');
  const nome = corta(o.cliente_nome, 50) || 'Cliente';
  const items = await itensIfood(o);
  const taxa = n2(o.taxa_entrega);
  const total = n2(items.reduce((s, i) => s + i.totalPrice, 0) + taxa);
  // Pagamento: ja pago (site/Pix/antes) nao leva cobranca; senao o entregador recebe (dinheiro com troco ou cartao).
  const p = b.pagamento || {};
  let pagamento;
  let payments;
  if (pagoAntes(o) || p.tipo === 'pago') {
    pagamento = { tipo: 'pago', valor: total };
  } else if (p.tipo === 'dinheiro') {
    const troco = p.troco_para !== undefined && p.troco_para !== null && p.troco_para !== '' ? n2(p.troco_para) : o.troco_para !== null ? n2(o.troco_para) : total;
    if (troco < total) throw new HttpError(400, 'o troco precisa ser para um valor maior ou igual ao total');
    pagamento = { tipo: 'dinheiro', troco_para: troco, valor: total };
    payments = { methods: [{ method: 'CASH', type: 'OFFLINE', value: total, cash: { changeFor: troco } }] };
  } else if (p.tipo === 'credito' || p.tipo === 'debito') {
    const bandeira = corta(p.bandeira, 30);
    if (!bandeira) throw new HttpError(400, 'escolha a bandeira do cartão');
    pagamento = { tipo: p.tipo, bandeira, valor: total };
    payments = { methods: [{ method: p.tipo === 'credito' ? 'CREDIT' : 'DEBIT', type: 'OFFLINE', value: total, card: { brand: bandeira } }] };
  } else {
    throw new HttpError(400, 'informe como o cliente paga (já pago, dinheiro ou cartão na entrega)');
  }
  const alocarMin = Math.max(0, Math.min(120, Math.floor(Number(b.alocar_em_min) || 0)));
  const corpo = {
    customer: { name: nome, phone: tel },
    delivery: {
      merchantFee: taxa, quoteId: b.cotacao_id, preparationTime: alocarMin * 60,
      deliveryAddress: {
        postalCode: e.cep, streetNumber: e.numero, streetName: e.logradouro, complement: e.complemento || undefined, reference: e.referencia || undefined,
        neighborhood: e.bairro, city: e.cidade, state: e.uf, country: 'BR', coordinates: { latitude: pt.lat, longitude: pt.lng },
      },
    },
    items,
    displayId: String(o.numero).slice(-4),
  };
  if (payments) corpo.payments = payments;
  let r;
  try { r = await api.criarEntrega(await token(integ), integ.merchant_id, corpo); } catch (err) { throw erroDoIfood(err); }
  if (!r.id) throw new HttpError(502, 'o iFood não devolveu o número da entrega: tente de novo');
  const cot = b.cotacao || {};
  const { rows } = await db().query(
    `INSERT INTO entregas_ifood (tenant_id, order_id, integracao_id, ifood_pedido_id, tracking_url, status, cotacao_id, valor, distancia_m, tempo_min, tempo_max,
       endereco, lat, lng, pagamento, alocar_em, criado_por)
     VALUES ($1, $2, $3, $4, $5, 'solicitada', $6, $7, $8, $9, $10, $11, $12, $13, $14, now() + ($15 || ' minutes')::interval, $16) RETURNING *`,
    [user.tenantId, o.id, integ.id, String(r.id), r.trackingUrl || null, b.cotacao_id, cot.valor === undefined ? null : n2(cot.valor),
      cot.distancia_m === undefined ? null : Math.round(Number(cot.distancia_m)), cot.tempo_min === undefined ? null : cot.tempo_min, cot.tempo_max === undefined ? null : cot.tempo_max,
      JSON.stringify(e), pt.lat, pt.lng, JSON.stringify(pagamento), String(alocarMin), user.id]
  );
  // o endereco conferido fica no pedido (e as coordenadas, se o pedido nao tinha)
  await db().query(
    `UPDATE orders SET entrega_endereco = $2, entrega_lat = COALESCE(entrega_lat, $3), entrega_lng = COALESCE(entrega_lng, $4), atualizado_em = now() WHERE id = $1`,
    [o.id, JSON.stringify({ ...e, lat: pt.lat, lng: pt.lng }), pt.lat, pt.lng]
  );
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_chamar_entregador', recurso: 'orders', recursoId: o.id,
    detalhes: { numero: o.numero, ifood_pedido_id: String(r.id), valor: cot.valor, pagamento: pagamento.tipo, alocar_em_min: alocarMin } });
  return publicaEntrega(rows[0]);
}

// ---------- cancelar ----------
async function entregaAtivaDoPedido(user, orderId) {
  const o = await pedidoDaEntrega(user, orderId);
  const e = await entregaAtual(o.id);
  if (!e || !ATIVAS.includes(e.status)) throw new HttpError(409, 'este pedido não tem entregador do iFood em andamento');
  const integ = await comum.integracao(e.integracao_id);
  return { o, e, integ };
}
async function motivosCancelar(user, orderId) {
  const { e, integ } = await entregaAtivaDoPedido(user, orderId);
  try { return await api.motivosCancelarEntrega(await token(integ), e.ifood_pedido_id); } catch (err) { throw erroDoIfood(err); }
}
async function cancelar(user, orderId, b) {
  const { o, e, integ } = await entregaAtivaDoPedido(user, orderId);
  const codigo = String((b || {}).codigo || '').trim();
  if (!codigo) throw new HttpError(400, 'escolha o motivo do cancelamento');
  const tk = await token(integ);
  let motivos;
  try { motivos = await api.motivosCancelarEntrega(tk, e.ifood_pedido_id); } catch (err) { throw erroDoIfood(err); }
  const m = motivos.find((x) => x.codigo === codigo);
  if (!m) throw new HttpError(409, motivos.length ? 'motivo inválido para esta entrega' : 'o iFood não permite mais cancelar esta entrega (o entregador já pode ter saído)');
  try { await api.cancelarEntrega(tk, e.ifood_pedido_id, codigo, m.descricao); } catch (err) { throw erroDoIfood(err); }
  await db().query(`UPDATE entregas_ifood SET erro = 'cancelamento pedido ao iFood: aguardando confirmação', atualizado_em = now() WHERE id = $1`, [e.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_cancelar_entregador', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, motivo: m.descricao } });
  return { ok: true };
}

// ---------- rastreio (posicao do entregador), no maximo a cada 25 s por entrega ----------
async function rastrear(user, orderId) {
  const o = await pedidoDaEntrega(user, orderId);
  const e = await entregaAtual(o.id);
  if (!e) throw new HttpError(404, 'este pedido não tem entrega do iFood');
  const acompanha = ['alocado', 'indo_loja', 'na_loja', 'em_rota', 'no_destino'].includes(e.status);
  const intervalo = require('../testeSimulado').ativo() ? 3000 : 25000; // modo teste: a moto anda no mapa
  if (acompanha && (!e.rastreio_em || Date.now() - new Date(e.rastreio_em).getTime() > intervalo)) {
    try {
      const integ = await comum.integracao(e.integracao_id);
      const t = await api.rastrearEntrega(await token(integ), e.ifood_pedido_id);
      await db().query(
        `UPDATE entregas_ifood SET entregador_lat = COALESCE($2, entregador_lat), entregador_lng = COALESCE($3, entregador_lng), previsao_entrega = COALESCE($4, previsao_entrega),
           rastreio_em = now() WHERE id = $1`,
        [e.id, t.latitude ?? null, t.longitude ?? null, t.expectedDelivery || null]
      );
    } catch (err) {
      // 404 antes de o entregador ser atribuido: normal, tenta de novo depois
      await db().query(`UPDATE entregas_ifood SET rastreio_em = now() WHERE id = $1`, [e.id]);
      if (!(err instanceof ErroPlataforma && err.status === 404)) console.error('ifood rastreio', err.message);
    }
  }
  return publicaEntrega(await entregaAtual(o.id));
}

// ---------- eventos (polling do iFood): devolve true se o evento era de uma entrega daqui ----------
const EVENTO = {
  REQUEST_DRIVER: 'buscando', RDR: 'buscando',
  REQUEST_DRIVER_SUCCESS: 'alocado', RDS: 'alocado', ASSIGN_DRIVER: 'alocado', ADR: 'alocado',
  GOING_TO_ORIGIN: 'indo_loja', GTO: 'indo_loja',
  ARRIVED_AT_ORIGIN: 'na_loja', AAO: 'na_loja',
  COLLECTED: 'em_rota', CLT: 'em_rota', DISPATCHED: 'em_rota', DSP: 'em_rota', DELIVERY_IN_TRANSIT: 'em_rota',
  ARRIVED_AT_DESTINATION: 'no_destino', AAD: 'no_destino',
  DELIVERY_CONCLUDED: 'entregue', CONCLUDED: 'entregue', CON: 'entregue',
  DELIVERY_CANCELLED: 'cancelada', CANCELLED: 'cancelada', CAN: 'cancelada',
  REQUEST_DRIVER_FAILED: 'falhou', RDF: 'falhou',
};

async function tratarEvento(integ, ev) {
  const e = (await db().query(`SELECT * FROM entregas_ifood WHERE ifood_pedido_id = $1`, [String(ev.orderId || '')])).rows[0];
  if (!e) return ev.salesChannel === 'POS'; // pedido Sob Demanda que nao e daqui: so reconhece (nunca importa como pedido do iFood)
  const cheio = ev.fullCode || ev.code || '';
  const md = ev.metadata || {};
  const nomeEntregador = md.workerName || md.driverName || (md.worker && md.worker.name) || null;
  if (cheio === 'DELIVERY_DROP_CODE_REQUESTED' || ev.code === 'DDCR') {
    await db().query(`UPDATE entregas_ifood SET codigo_entrega = $2, ultimo_evento = $3, atualizado_em = now() WHERE id = $1`, [e.id, md.CODE || md.code || null, cheio]);
    return true;
  }
  if (cheio === 'CANCELLATION_REQUEST_FAILED') {
    await db().query(`UPDATE entregas_ifood SET erro = $2, ultimo_evento = $3, atualizado_em = now() WHERE id = $1`, [e.id, 'o iFood não cancelou a entrega (o entregador pode já ter saído)', cheio]);
    return true;
  }
  const novo = EVENTO[cheio] || EVENTO[ev.code];
  if (!novo) {
    await db().query(`UPDATE entregas_ifood SET ultimo_evento = $2, entregador_nome = COALESCE($3, entregador_nome), atualizado_em = now() WHERE id = $1`, [e.id, cheio, nomeEntregador]);
    return true;
  }
  const encerrada = ['entregue', 'cancelada', 'falhou'].includes(e.status);
  const avanca = novo === 'cancelada' || novo === 'falhou' ? !encerrada : !encerrada && (ORDEM[novo] ?? 0) > (ORDEM[e.status] ?? 0);
  if (avanca) {
    const erro = novo === 'falhou' ? `o iFood não conseguiu um entregador${md.reason ? `: ${md.reason}` : ''}` : novo === 'cancelada' ? 'entrega cancelada no iFood' : null;
    await db().query(
      `UPDATE entregas_ifood SET status = $2, ultimo_evento = $3, entregador_nome = COALESCE($4, entregador_nome), erro = $5, atualizado_em = now() WHERE id = $1`,
      [e.id, novo, cheio, nomeEntregador, erro]
    );
    // entregador saiu com o pedido: o pedido daqui vai para "Saiu p/ entrega" (o cliente recebe o aviso do WhatsApp, se ligado)
    if (novo === 'em_rota' || novo === 'no_destino' || novo === 'entregue') {
      const o = (await db().query(`SELECT id, status FROM orders WHERE id = $1`, [e.order_id])).rows[0];
      if (o && ['novo', 'em_preparo', 'pronto'].includes(o.status)) {
        await db().query(`UPDATE orders SET status = 'saiu_entrega', atualizado_em = now() WHERE id = $1`, [o.id]);
        await db().query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'saiu_entrega', NULL)`, [o.id, o.status]);
      }
    }
  } else if (nomeEntregador) {
    await db().query(`UPDATE entregas_ifood SET entregador_nome = $2, atualizado_em = now() WHERE id = $1`, [e.id, nomeEntregador]);
  }
  return true;
}

module.exports = { preparar, cotar, solicitar, motivosCancelar, cancelar, rastrear, tratarEvento, buscarCep, enderecoDoTexto, ATIVAS, entregaAtual };
