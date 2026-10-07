// Configuracao do cupom do cliente e da comanda da cozinha (uma por loja, guardada em locations.cupom_config).
const PADRAO = {
  cliente: {
    largura_mm: 80,
    cabecalho: '',
    rodape: 'Obrigado pela preferência!',
    mostrar_empresa: true,
    mostrar_loja: true,
    mostrar_data: true,
    mostrar_numero_venda: true,
    mostrar_terminal: true,
    mostrar_operador: true,
    mostrar_codigo_produto: false,
    mostrar_observacao: true,
    mostrar_desconto: true,
    mostrar_forma_pagamento: true,
    mostrar_troco: true,
    tamanho_pedido: 'grande',
    vias: 1,
    imprimir_automatico: false,
  },
  cozinha: {
    ativo: false,
    largura_mm: 80,
    cabecalho: 'COMANDA DA COZINHA',
    itens: 'preparo',
    mostrar_loja: true,
    mostrar_data: true,
    mostrar_operador: false,
    mostrar_valores: false,
    tamanho_pedido: 'grande',
    imprimir_automatico: false,
  },
};

const LARGURAS = [58, 80];
const TAMANHOS = ['medio', 'grande', 'gigante'];

function bool(v, padrao) { return typeof v === 'boolean' ? v : padrao; }
function texto(v, padrao, max) { return typeof v === 'string' ? v.slice(0, max) : padrao; }

// Junta o que esta salvo com o padrao, validando cada campo (campo invalido volta ao padrao).
function configEfetiva(salva) {
  const s = salva && typeof salva === 'object' ? salva : {};
  const c = { ...PADRAO.cliente, ...(s.cliente || {}) };
  const k = { ...PADRAO.cozinha, ...(s.cozinha || {}) };
  const P = PADRAO;
  return {
    cliente: {
      largura_mm: LARGURAS.includes(Number(c.largura_mm)) ? Number(c.largura_mm) : P.cliente.largura_mm,
      cabecalho: texto(c.cabecalho, P.cliente.cabecalho, 400),
      rodape: texto(c.rodape, P.cliente.rodape, 300),
      mostrar_empresa: bool(c.mostrar_empresa, P.cliente.mostrar_empresa),
      mostrar_loja: bool(c.mostrar_loja, P.cliente.mostrar_loja),
      mostrar_data: bool(c.mostrar_data, P.cliente.mostrar_data),
      mostrar_numero_venda: bool(c.mostrar_numero_venda, P.cliente.mostrar_numero_venda),
      mostrar_terminal: bool(c.mostrar_terminal, P.cliente.mostrar_terminal),
      mostrar_operador: bool(c.mostrar_operador, P.cliente.mostrar_operador),
      mostrar_codigo_produto: bool(c.mostrar_codigo_produto, P.cliente.mostrar_codigo_produto),
      mostrar_observacao: bool(c.mostrar_observacao, P.cliente.mostrar_observacao),
      mostrar_desconto: bool(c.mostrar_desconto, P.cliente.mostrar_desconto),
      mostrar_forma_pagamento: bool(c.mostrar_forma_pagamento, P.cliente.mostrar_forma_pagamento),
      mostrar_troco: bool(c.mostrar_troco, P.cliente.mostrar_troco),
      tamanho_pedido: TAMANHOS.includes(c.tamanho_pedido) ? c.tamanho_pedido : P.cliente.tamanho_pedido,
      vias: [1, 2, 3].includes(Number(c.vias)) ? Number(c.vias) : 1,
      imprimir_automatico: bool(c.imprimir_automatico, P.cliente.imprimir_automatico),
    },
    cozinha: {
      ativo: bool(k.ativo, P.cozinha.ativo),
      largura_mm: LARGURAS.includes(Number(k.largura_mm)) ? Number(k.largura_mm) : P.cozinha.largura_mm,
      cabecalho: texto(k.cabecalho, P.cozinha.cabecalho, 200),
      itens: k.itens === 'todos' ? 'todos' : 'preparo',
      mostrar_loja: bool(k.mostrar_loja, P.cozinha.mostrar_loja),
      mostrar_data: bool(k.mostrar_data, P.cozinha.mostrar_data),
      mostrar_operador: bool(k.mostrar_operador, P.cozinha.mostrar_operador),
      mostrar_valores: bool(k.mostrar_valores, P.cozinha.mostrar_valores),
      tamanho_pedido: TAMANHOS.includes(k.tamanho_pedido) ? k.tamanho_pedido : P.cozinha.tamanho_pedido,
      imprimir_automatico: bool(k.imprimir_automatico, P.cozinha.imprimir_automatico),
    },
  };
}

module.exports = { PADRAO, configEfetiva };
