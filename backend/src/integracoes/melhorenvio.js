// Melhor Envio (frete por transportadora da loja online). Cada empresa usa a PROPRIA conta: token pessoal gerado no
// painel do Melhor Envio (Integracoes > Permissoes de acesso), com os escopos de cotacao, carrinho, compra, geracao,
// impressao, rastreio e cancelamento de etiquetas. A etiqueta e paga com o saldo da conta do lojista.
// API v2: https://melhorenvio.com.br/api/v2 (sandbox: https://sandbox.melhorenvio.com.br/api/v2).
// ME_API_URL troca o endereco (simulador local: npm run me:simulador).
const { requisicao, ErroPlataforma } = require('./http');

const base = (sandbox) => (process.env.ME_API_URL || (sandbox ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br')).replace(/\/+$/, '');
// O Melhor Envio exige um User-Agent com o nome da aplicacao e um e-mail de contato tecnico.
const agente = () => `GiroStock (${process.env.ME_CONTATO || process.env.SMTP_REMETENTE || 'suporte@girostock.com.br'})`;

// Mensagem legivel do erro (ele responde { message, errors: { campo: [msg] } } ou { error }).
function erroMe(r, contexto) {
  const c = r.corpo || {};
  let msg = c.message || c.error || `HTTP ${r.status}`;
  if (c.errors && typeof c.errors === 'object') {
    const primeiro = Object.values(c.errors).flat()[0];
    if (primeiro) msg = String(primeiro);
  }
  if (r.status === 401) msg = 'token inválido ou expirado (gere outro no Melhor Envio)';
  return new ErroPlataforma(r.status, `Melhor Envio (${contexto}): ${msg}`, c);
}

async function chamar(cfg, metodo, caminho, opcoes = {}) {
  const r = await requisicao(metodo, `${base(cfg.sandbox)}/api/v2${caminho}`, {
    headers: { authorization: `Bearer ${cfg.token}`, 'user-agent': agente() },
    json: opcoes.json,
    timeoutMs: opcoes.timeoutMs || 20000,
  });
  if (r.status >= 200 && r.status < 300) return r.corpo;
  throw erroMe(r, opcoes.contexto || caminho);
}

// Confere o token: devolve a conta (nome, e-mail) e o saldo.
async function conta(cfg) {
  const me = await chamar(cfg, 'GET', '/me', { contexto: 'conferir a conta' });
  let saldo = null;
  try { saldo = Number((await chamar(cfg, 'GET', '/me/balance', { contexto: 'saldo' })).balance); } catch { /* sem o escopo de saldo */ }
  return { nome: [me.firstname, me.lastname].filter(Boolean).join(' ') || me.name || '', email: me.email || '', saldo };
}

// Servicos de frete disponiveis (id, nome, transportadora, logo).
async function servicos(cfg) {
  const lista = await chamar(cfg, 'GET', '/me/shipment/services', { contexto: 'listar os serviços' });
  return (Array.isArray(lista) ? lista : []).map((s) => ({
    id: Number(s.id), nome: s.name, transportadora: s.company ? s.company.name : '', logo: s.company ? s.company.picture || null : null,
  }));
}

// Cotacao por produtos. d: { de (cep), para (cep), produtos: [{ id, peso_kg, altura_cm, largura_cm, comprimento_cm, valor, quantidade }], servicos: [ids] }
// Devolve [{ id, nome, transportadora, logo, preco, prazo_dias, pacotes: [{ altura, largura, comprimento, peso }] }]
// (so os servicos que a transportadora atende; os com erro ficam de fora).
async function cotar(cfg, d) {
  const r = await chamar(cfg, 'POST', '/me/shipment/calculate', {
    contexto: 'calcular o frete',
    json: {
      from: { postal_code: d.de },
      to: { postal_code: d.para },
      products: d.produtos.map((p) => ({
        id: String(p.id), width: p.largura_cm, height: p.altura_cm, length: p.comprimento_cm, weight: p.peso_kg,
        insurance_value: p.valor, quantity: p.quantidade,
      })),
      options: { receipt: false, own_hand: false },
      ...(d.servicos && d.servicos.length ? { services: d.servicos.join(',') } : {}),
    },
  });
  return (Array.isArray(r) ? r : []).filter((s) => !s.error && s.price !== undefined && s.price !== null).map((s) => ({
    id: Number(s.id),
    nome: s.name,
    transportadora: s.company ? s.company.name : '',
    logo: s.company ? s.company.picture || null : null,
    preco: Number(s.custom_price !== undefined && s.custom_price !== null ? s.custom_price : s.price),
    prazo_dias: Number(s.custom_delivery_time !== undefined && s.custom_delivery_time !== null ? s.custom_delivery_time : s.delivery_time) || null,
    pacotes: (s.packages || []).map((p) => ({
      altura: Number(p.dimensions ? p.dimensions.height : p.height), largura: Number(p.dimensions ? p.dimensions.width : p.width),
      comprimento: Number(p.dimensions ? p.dimensions.length : p.length), peso: Number(p.weight),
    })),
  }));
}

const endereco = (e) => ({
  name: e.nome, phone: String(e.telefone || '').replace(/\D/g, ''), email: e.email || undefined,
  ...(String(e.documento || '').replace(/\D/g, '').length === 14 ? { company_document: String(e.documento).replace(/\D/g, '') } : { document: String(e.documento || '').replace(/\D/g, '') || undefined }),
  address: e.logradouro, number: e.numero || 'S/N', complement: e.complemento || undefined, district: e.bairro, city: e.cidade,
  state_abbr: e.uf, country_id: 'BR', postal_code: String(e.cep || '').replace(/\D/g, ''),
});

// Compra a etiqueta: carrinho -> pagamento (saldo da conta) -> geracao. d: { servico, remetente, destinatario, produtos:
// [{ nome, quantidade, valor }], volumes: [{ altura, largura, comprimento, peso }], valor_declarado, nfe, numero_pedido }
// Devolve { id, status, codigo (rastreio da transportadora, se ja houver) }.
async function comprarEtiqueta(cfg, d) {
  const carrinho = await chamar(cfg, 'POST', '/me/cart', {
    contexto: 'colocar a etiqueta no carrinho',
    json: {
      service: d.servico,
      from: endereco(d.remetente),
      to: endereco(d.destinatario),
      products: d.produtos.map((p) => ({ name: p.nome, quantity: p.quantidade, unitary_value: p.valor })),
      volumes: d.volumes.map((v) => ({ height: v.altura, width: v.largura, length: v.comprimento, weight: v.peso })),
      options: {
        insurance_value: d.valor_declarado, receipt: false, own_hand: false, reverse: false,
        non_commercial: !d.nfe, ...(d.nfe ? { invoice: { key: d.nfe } } : {}),
        platform: 'GiroStock', tags: [{ tag: `Pedido ${d.numero_pedido}`, url: null }],
      },
    },
  });
  const id = carrinho.id;
  try {
    await chamar(cfg, 'POST', '/me/shipment/checkout', { contexto: 'pagar a etiqueta (saldo do Melhor Envio)', json: { orders: [id] } });
  } catch (err) {
    // sem saldo/erro no pagamento: tira do carrinho para nao ficar pendurado
    await chamar(cfg, 'DELETE', `/me/cart/${id}`, { contexto: 'limpar o carrinho' }).catch(() => {});
    throw err;
  }
  await chamar(cfg, 'POST', '/me/shipment/generate', { contexto: 'gerar a etiqueta', json: { orders: [id] } });
  const r = await rastrear(cfg, [id]);
  return { id, ...(r[id] || { status: 'released', codigo: null }) };
}

// Link para imprimir a etiqueta (PDF).
async function linkEtiqueta(cfg, id) {
  const r = await chamar(cfg, 'POST', '/me/shipment/print', { contexto: 'imprimir a etiqueta', json: { mode: 'private', orders: [id] } });
  return r.url;
}

// Situacao das etiquetas: { [id]: { status, codigo, codigo_me, postado_em, entregue_em } }
async function rastrear(cfg, ids) {
  const r = await chamar(cfg, 'POST', '/me/shipment/tracking', { contexto: 'rastrear', json: { orders: ids } });
  const out = {};
  for (const [id, t] of Object.entries(r || {})) {
    if (!t || typeof t !== 'object') continue;
    out[id] = { status: t.status || null, codigo: t.tracking || null, codigo_me: t.melhorenvio_tracking || null, postado_em: t.posted_at || null, entregue_em: t.delivered_at || null };
  }
  return out;
}

// Cancela a etiqueta (antes da postagem; o valor volta para o saldo da conta).
async function cancelarEtiqueta(cfg, id, motivo) {
  return chamar(cfg, 'POST', '/me/shipment/cancel', {
    contexto: 'cancelar a etiqueta',
    json: { order: { id, reason_id: '2', description: String(motivo || 'pedido cancelado').slice(0, 250) } },
  });
}

// Pagina publica de rastreio (funciona para Correios, Jadlog e as demais).
const urlRastreio = (codigo) => (codigo ? `https://www.melhorrastreio.com.br/rastreio/${encodeURIComponent(codigo)}` : null);

module.exports = { conta, servicos, cotar, comprarEtiqueta, linkEtiqueta, rastrear, cancelarEtiqueta, urlRastreio };
