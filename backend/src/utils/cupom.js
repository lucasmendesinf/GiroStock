// Configuracao do cupom do cliente, da comanda da cozinha e da senha do cliente (uma por loja, guardada em locations.cupom_config).
const PADRAO = {
  geral: {
    impressao_separada: false,
  },
  cliente: {
    largura_mm: 80,
    impressora: '',
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
    impressora: '',
    cabecalho: 'COMANDA DA COZINHA',
    itens: 'preparo',
    mostrar_loja: true,
    mostrar_data: true,
    mostrar_operador: false,
    mostrar_valores: false,
    tamanho_pedido: 'grande',
    imprimir_automatico: false,
  },
  senha: {
    ativo: false,
    largura_mm: 80,
    impressora: '',
    titulo: 'SENHA DO PEDIDO',
    mensagem: 'Apresente esta senha para retirar o seu pedido.',
    mostrar_itens: true,
    mostrar_loja: true,
    mostrar_data: true,
    tamanho_pedido: 'gigante',
    imprimir_automatico: false,
  },
};

const LARGURAS = [58, 80];
const TAMANHOS = ['medio', 'grande', 'gigante'];

function bool(v, padrao) { return typeof v === 'boolean' ? v : padrao; }
function texto(v, padrao, max) { return typeof v === 'string' ? v.slice(0, max) : padrao; }
function largura(v, padrao) { return LARGURAS.includes(Number(v)) ? Number(v) : padrao; }
function tamanho(v, padrao) { return TAMANHOS.includes(v) ? v : padrao; }

// Junta o que esta salvo com o padrao, validando cada campo (campo invalido volta ao padrao).
function configEfetiva(salva) {
  const s = salva && typeof salva === 'object' ? salva : {};
  const g = { ...PADRAO.geral, ...(s.geral || {}) };
  const c = { ...PADRAO.cliente, ...(s.cliente || {}) };
  const k = { ...PADRAO.cozinha, ...(s.cozinha || {}) };
  const n = { ...PADRAO.senha, ...(s.senha || {}) };
  const P = PADRAO;
  return {
    geral: {
      impressao_separada: bool(g.impressao_separada, P.geral.impressao_separada),
    },
    cliente: {
      largura_mm: largura(c.largura_mm, P.cliente.largura_mm),
      impressora: texto(c.impressora, P.cliente.impressora, 80),
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
      tamanho_pedido: tamanho(c.tamanho_pedido, P.cliente.tamanho_pedido),
      vias: [1, 2, 3].includes(Number(c.vias)) ? Number(c.vias) : 1,
      imprimir_automatico: bool(c.imprimir_automatico, P.cliente.imprimir_automatico),
    },
    cozinha: {
      ativo: bool(k.ativo, P.cozinha.ativo),
      largura_mm: largura(k.largura_mm, P.cozinha.largura_mm),
      impressora: texto(k.impressora, P.cozinha.impressora, 80),
      cabecalho: texto(k.cabecalho, P.cozinha.cabecalho, 200),
      itens: k.itens === 'todos' ? 'todos' : 'preparo',
      mostrar_loja: bool(k.mostrar_loja, P.cozinha.mostrar_loja),
      mostrar_data: bool(k.mostrar_data, P.cozinha.mostrar_data),
      mostrar_operador: bool(k.mostrar_operador, P.cozinha.mostrar_operador),
      mostrar_valores: bool(k.mostrar_valores, P.cozinha.mostrar_valores),
      tamanho_pedido: tamanho(k.tamanho_pedido, P.cozinha.tamanho_pedido),
      imprimir_automatico: bool(k.imprimir_automatico, P.cozinha.imprimir_automatico),
    },
    senha: {
      ativo: bool(n.ativo, P.senha.ativo),
      largura_mm: largura(n.largura_mm, P.senha.largura_mm),
      impressora: texto(n.impressora, P.senha.impressora, 80),
      titulo: texto(n.titulo, P.senha.titulo, 200),
      mensagem: texto(n.mensagem, P.senha.mensagem, 300),
      mostrar_itens: bool(n.mostrar_itens, P.senha.mostrar_itens),
      mostrar_loja: bool(n.mostrar_loja, P.senha.mostrar_loja),
      mostrar_data: bool(n.mostrar_data, P.senha.mostrar_data),
      tamanho_pedido: tamanho(n.tamanho_pedido, P.senha.tamanho_pedido),
      imprimir_automatico: bool(n.imprimir_automatico, P.senha.imprimir_automatico),
    },
  };
}

module.exports = { PADRAO, configEfetiva };
