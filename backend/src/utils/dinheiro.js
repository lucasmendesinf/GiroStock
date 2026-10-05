// Dinheiro em centavos inteiros: evita erros de ponto flutuante do JS
// (ex: 0,1 + 0,2 = 0,30000000000000004; 19,90 x 3 = 59,699999999999996).
// No banco os valores ja sao NUMERIC (decimal exato); aqui garantimos o mesmo nas contas.

// Arredonda para o inteiro mais proximo (metade para cima), tolerando o ruido do float.
function arredondarCentavos(x) {
  return Math.sign(x) * Math.round(Math.abs(x) + 1e-6);
}

function centavos(valor) {
  return arredondarCentavos(Number(valor) * 100);
}

function reais(c) {
  return c / 100;
}

function somar(a, b) {
  return reais(centavos(a) + centavos(b));
}

// true se o valor tem no maximo 2 casas decimais (ex: 12.5 e 12.50 sim; 12.505 nao).
function temNoMaximoCentavos(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

module.exports = { centavos, reais, somar, arredondarCentavos, temNoMaximoCentavos };
