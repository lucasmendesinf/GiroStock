// Modulos (segmentos) que o Master libera por plano ou por empresa: o cliente so ve e usa o que contratou.
// Sempre incluido em qualquer plano: Inicio, Produtos & Estoque, Fornecedores, Lojas & PDVs, Usuarios e Relatorios.
//
// chave       -> guardada em planos.recursos / tenants.recursos ({"pdv": true, "pedidos": false, ...})
// padrao      -> valor quando o plano ainda nao tem a chave (pdv/lanchonete sempre existiram; o resto e opcional)
// requer      -> modulos que precisam estar ligados junto (ex.: Pedidos e finalizado no caixa do PDV)
// disponivel  -> false = ainda em desenvolvimento ("em breve"): ja pode ser liberado, passa a valer quando ficar pronto
// areas       -> areas de permissao desligadas para todos da empresa quando o modulo esta desligado
const MODULOS = [
  {
    chave: 'pdv', nome: 'Ponto de venda (PDV)', padrao: true, disponivel: true, requer: [],
    descricao: 'Caixa, venda no balcão com leitor de código de barras, formas de pagamento, sangria/suprimento e cupom.',
    areas: ['Vendas', 'SangriaSuprimento', 'Desconto', 'FecharCaixa', 'CancelarVendas'],
  },
  {
    chave: 'lanchonete', nome: 'Lanchonete e cozinha', padrao: true, disponivel: true, requer: ['pdv'],
    descricao: 'Lanches com ficha técnica, insumos com baixa automática e comanda da cozinha.',
    areas: [],
  },
  {
    chave: 'pedidos', nome: 'Pedidos', padrao: false, disponivel: true, requer: ['pdv'],
    descricao: 'Pedidos de mesa, retirada e entrega (balcão, telefone e WhatsApp), entregadores e acompanhamento.',
    areas: ['Pedidos'],
  },
  {
    chave: 'clientes', nome: 'Clientes', padrao: false, disponivel: true, requer: [],
    descricao: 'Base de clientes, segmentos e mensagens por WhatsApp.',
    areas: ['Clientes'],
  },
  {
    chave: 'delivery_apps', nome: 'iFood e 99Food', padrao: false, disponivel: true, requer: ['pedidos'],
    descricao: 'Pedidos do iFood e da 99Food entrando direto na tela de Pedidos (aceite, preparo, entrega e cancelamento sincronizados).',
    areas: [],
  },
  {
    chave: 'eventos', nome: 'Casa de shows e eventos', padrao: false, disponivel: false, requer: ['pdv'],
    descricao: 'Agenda de eventos, PDVs e estoque do evento, faturamento e perdas por evento.',
    areas: [],
  },
  {
    chave: 'loja_virtual', nome: 'Loja virtual', padrao: false, disponivel: false, requer: [],
    descricao: 'Catálogo online, carrinho, retirada e delivery com taxas por região.',
    areas: [],
  },
  {
    chave: 'financeiro', nome: 'Financeiro', padrao: false, disponivel: false, requer: [],
    descricao: 'Contas a pagar e a receber, fluxo de caixa e indicadores.',
    areas: [],
  },
];

const CHAVES = MODULOS.map((m) => m.chave);
const POR_CHAVE = Object.fromEntries(MODULOS.map((m) => [m.chave, m]));

// Desliga em cascata o que depende de um modulo desligado (ex.: sem PDV, sem Pedidos).
function aplicarDependencias(mods) {
  const r = { ...mods };
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (const m of MODULOS) {
      if (r[m.chave] && m.requer.some((dep) => !r[dep])) { r[m.chave] = false; mudou = true; }
    }
  }
  return r;
}

// Mensagem do primeiro modulo ligado sem a dependencia (para recusar a gravacao com explicacao), ou null.
function conflitoDeDependencia(mods) {
  for (const m of MODULOS) {
    if (!mods[m.chave]) continue;
    const falta = m.requer.find((dep) => !mods[dep]);
    if (falta) return `o módulo "${m.nome}" precisa do módulo "${POR_CHAVE[falta].nome}" ligado`;
  }
  return null;
}

// Catalogo para as telas (sem as areas internas).
function catalogo() {
  return MODULOS.map(({ chave, nome, descricao, disponivel, requer }) => ({ chave, nome, descricao, disponivel, requer }));
}

module.exports = { MODULOS, CHAVES, POR_CHAVE, aplicarDependencias, conflitoDeDependencia, catalogo };
