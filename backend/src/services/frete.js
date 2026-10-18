// Frete por transportadora da loja online (Melhor Envio). Cotacao pelo CEP com as medidas/peso dos produtos (ou a
// embalagem padrao da loja), regras da loja (acrescimo, dias de separacao, frete gratis a partir de um valor) e a
// compra da etiqueta no painel. Loja do tipo cardapio nao usa (entrega so pelos bairros).
const crypto = require('crypto');
const { HttpError } = require('../utils/http');
const { decifrar, cifrar } = require('./totp');
const me = require('../integracoes/melhorenvio');

const n2 = (v) => Number(Number(v || 0).toFixed(2));
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const PADRAO = { peso_kg: 0.3, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 };

const cfgMe = (loja) => {
  if (!loja.me_token_cript) throw new HttpError(422, 'conecte a conta do Melhor Envio (Loja virtual › Entrega)');
  return { token: decifrar(loja.me_token_cript), sandbox: !!loja.me_sandbox };
};
const remetente = (loja) => loja.envio_remetente || {};
// Envio por transportadora ligado e pronto (conta conectada e CEP de origem). So loja online (varejo).
function envioDisponivel(loja) {
  return loja.tipo !== 'cardapio' && !!loja.envio_ativo && !!loja.me_token_cript && soDigitos(remetente(loja).cep).length === 8;
}
// Entrega local (bairros) para este endereco? Com envio por transportadora ligado, so na cidade da loja.
function entregaLocalNaCidade(loja, cidade) {
  if (!envioDisponivel(loja)) return true;
  const daLoja = semAcento(remetente(loja).cidade);
  return !daLoja || !cidade || semAcento(cidade) === daLoja;
}

// Produtos do carrinho com peso/medidas (do produto no site ou a embalagem padrao) e valor (seguro).
async function produtosParaCotar(dbc, loja, itens) {
  const ids = [...new Set(itens.map((i) => i.product_id))];
  const med = new Map((await dbc.query(
    `SELECT product_id, peso_kg, altura_cm, largura_cm, comprimento_cm FROM lv_produtos WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`,
    [loja.tenant_id, ids]
  )).rows.map((r) => [r.product_id, r]));
  const pad = { ...PADRAO, ...(loja.envio_padrao || {}) };
  return itens.map((i) => {
    const m = med.get(i.product_id) || {};
    return {
      id: i.product_id,
      peso_kg: Number(m.peso_kg || pad.peso_kg), altura_cm: Number(m.altura_cm || pad.altura_cm),
      largura_cm: Number(m.largura_cm || pad.largura_cm), comprimento_cm: Number(m.comprimento_cm || pad.comprimento_cm),
      valor: n2(i.preco_unitario), quantidade: Math.max(1, Math.ceil(Number(i.quantidade))),
    };
  });
}

// Cache curto das cotacoes (mesmo CEP e mesmos produtos): o site recalcula o carrinho a cada mudanca.
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;
async function cotarNaTransportadora(loja, cep, produtos) {
  const chave = crypto.createHash('sha1').update(JSON.stringify([loja.id, loja.me_conectado_em, loja.envio_servicos, cep, produtos])).digest('hex');
  const c = cache.get(chave);
  if (c && Date.now() - c.em < CACHE_MS) return c.opcoes;
  const opcoes = await me.cotar(cfgMe(loja), {
    de: soDigitos(remetente(loja).cep), para: cep, produtos, servicos: loja.envio_servicos || [],
  });
  cache.set(chave, { em: Date.now(), opcoes });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return opcoes;
}

// Opcoes de frete para o site: preco final (com acrescimo; gratis no mais barato a partir do valor da loja) e prazo
// (transportadora + dias de separacao). itens: [{ product_id, quantidade, preco_unitario }].
async function opcoesDeEnvio(dbc, loja, cep, itens, subtotal) {
  const destino = soDigitos(cep);
  if (destino.length !== 8) throw new HttpError(400, 'CEP inválido');
  const produtos = await produtosParaCotar(dbc, loja, itens);
  let lista;
  try {
    lista = await cotarNaTransportadora(loja, destino, produtos);
  } catch (err) {
    throw new HttpError(err.status === 422 ? 422 : 502, `não foi possível calcular o frete agora: ${err.message.replace(/^Melhor Envio \([^)]*\): /, '')}`);
  }
  const acrescimo = n2(loja.envio_acrescimo);
  const gratisAcima = loja.envio_gratis_acima === null || loja.envio_gratis_acima === undefined ? null : n2(loja.envio_gratis_acima);
  const opcoes = lista.map((o) => ({
    id: o.id, nome: o.transportadora ? `${o.transportadora} ${o.nome}` : o.nome, servico: o.nome, transportadora: o.transportadora, logo: o.logo,
    preco: n2(o.preco + acrescimo), custo: n2(o.preco), prazo_dias: o.prazo_dias ? o.prazo_dias + Number(loja.envio_dias_extra || 0) : null, gratis: false, pacotes: o.pacotes,
  })).sort((a, b) => a.preco - b.preco);
  if (gratisAcima !== null && subtotal >= gratisAcima && opcoes.length) { opcoes[0].preco = 0; opcoes[0].gratis = true; }
  return opcoes;
}

// Simulacao no painel: um pacote com a embalagem padrao (valor declarado R$ 100).
async function simularPadrao(loja, cep) {
  const destino = soDigitos(cep);
  if (destino.length !== 8) throw new HttpError(400, 'CEP inválido');
  const pad = { ...PADRAO, ...(loja.envio_padrao || {}) };
  try {
    const lista = await me.cotar(cfgMe(loja), { de: soDigitos(remetente(loja).cep), para: destino, servicos: loja.envio_servicos || [], produtos: [{ id: 'simulacao', ...pad, valor: 100, quantidade: 1 }] });
    return lista.map((o) => ({ id: o.id, nome: o.transportadora ? `${o.transportadora} ${o.nome}` : o.nome, custo: n2(o.preco), preco: n2(o.preco + n2(loja.envio_acrescimo)), prazo_dias: o.prazo_dias ? o.prazo_dias + Number(loja.envio_dias_extra || 0) : null }));
  } catch (err) {
    throw new HttpError(err.status && err.status < 500 ? 422 : 502, err.message);
  }
}

// ---------- configuracao (painel) ----------
const TEXTO = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
function normalizarRemetente(e) {
  if (!e || typeof e !== 'object') throw new HttpError(400, 'remetente inválido');
  const r = {
    nome: TEXTO(e.nome, 80), telefone: soDigitos(e.telefone).slice(0, 13), email: TEXTO(e.email, 120), documento: soDigitos(e.documento),
    cep: soDigitos(e.cep), logradouro: TEXTO(e.logradouro, 120), numero: TEXTO(e.numero, 20), complemento: TEXTO(e.complemento, 60),
    bairro: TEXTO(e.bairro, 80), cidade: TEXTO(e.cidade, 80), uf: TEXTO(e.uf, 2).toUpperCase(),
  };
  if (r.cep && r.cep.length !== 8) throw new HttpError(400, 'CEP de origem inválido');
  if (r.documento && ![11, 14].includes(r.documento.length)) throw new HttpError(400, 'CPF/CNPJ do remetente inválido');
  if (r.uf && !/^[A-Z]{2}$/.test(r.uf)) throw new HttpError(400, 'UF do remetente inválida');
  return r;
}
function normalizarPadrao(p) {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'embalagem padrão inválida');
  const r = {};
  for (const [k, max] of [['peso_kg', 30], ['altura_cm', 100], ['largura_cm', 100], ['comprimento_cm', 100]]) {
    const x = Number(p[k]);
    if (!(x > 0) || x > max) throw new HttpError(400, `embalagem padrão: ${k.replace('_', ' ')} inválido (até ${max})`);
    r[k] = x;
  }
  return r;
}
// Pendencias do envio para a tela (o que falta para a etiqueta sair).
function pendenciasEnvio(loja) {
  if (!loja.envio_ativo) return [];
  const r = remetente(loja);
  const p = [];
  if (!loja.me_token_cript) p.push('conecte a conta do Melhor Envio (Entrega)');
  const faltam = ['nome', 'telefone', 'documento', 'cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'].filter((k) => !r[k]);
  if (faltam.length) p.push('complete os dados do remetente para a etiqueta (Entrega)');
  return p;
}

// ---------- etiqueta ----------
// Endereco do cliente guardado no pedido (texto) nao serve para a etiqueta: usa o endereco da conta salvo no pedido.
async function comprarEtiqueta(dbc, loja, o, opcoes = {}) {
  if (!o.frete_servico_id) throw new HttpError(409, 'este pedido não é de envio por transportadora');
  if (o.me_envio_id && o.me_status !== 'canceled') throw new HttpError(409, 'a etiqueta deste pedido já foi comprada');
  const r = remetente(loja);
  const faltam = ['nome', 'telefone', 'documento', 'cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'].filter((k) => !r[k]);
  if (faltam.length) throw new HttpError(422, 'complete os dados do remetente (Loja virtual › Entrega) para comprar a etiqueta');
  const dest = o.frete_destino;
  if (!dest) throw new HttpError(422, 'endereço do cliente incompleto para a etiqueta');
  const itens = (await dbc.query(
    `SELECT COALESCE(lp.nome_site, p.nome) AS nome, oi.quantidade, oi.preco_unitario FROM order_items oi JOIN products p ON p.id = oi.product_id
     LEFT JOIN lv_produtos lp ON lp.product_id = oi.product_id WHERE oi.order_id = $1`,
    [o.id]
  )).rows;
  const valor = n2(itens.reduce((s, i) => s + Number(i.preco_unitario) * Number(i.quantidade), 0));
  let volumes = Array.isArray(o.frete_volumes) && o.frete_volumes.length ? o.frete_volumes : null;
  if (!volumes) {
    const pad = { ...PADRAO, ...(loja.envio_padrao || {}) };
    volumes = [{ altura: pad.altura_cm, largura: pad.largura_cm, comprimento: pad.comprimento_cm, peso: pad.peso_kg }];
  }
  const nfe = soDigitos(opcoes.nfe);
  if (nfe && nfe.length !== 44) throw new HttpError(400, 'chave da NF-e inválida (44 números)');
  if (!nfe && !loja.envio_declaracao) throw new HttpError(400, 'informe a chave da NF-e para emitir a etiqueta');
  try {
    return await me.comprarEtiqueta(cfgMe(loja), {
      servico: o.frete_servico_id, remetente: { ...r, email: r.email || loja.email }, destinatario: dest,
      produtos: itens.map((i) => ({ nome: i.nome, quantidade: Math.max(1, Math.ceil(Number(i.quantidade))), valor: n2(i.preco_unitario) })),
      volumes, valor_declarado: valor, nfe: nfe || null, numero_pedido: o.numero,
    });
  } catch (err) {
    throw new HttpError(err.status && err.status < 500 ? 422 : 502, err.message);
  }
}

module.exports = {
  envioDisponivel, entregaLocalNaCidade, opcoesDeEnvio, produtosParaCotar, normalizarRemetente, normalizarPadrao, pendenciasEnvio,
  comprarEtiqueta, simularPadrao, cfgMe, cifrar, soDigitos, me,
};
