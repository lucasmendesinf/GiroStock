function onlyDigits(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\D/g, '') : '';
}

function isValidCpf(cpf) {
  if (!/^[0-9]{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(cpf.slice(0, 9)) === Number(cpf[9]) && digito(cpf.slice(0, 10)) === Number(cpf[10]);
}

function isValidCnpj(cnpj) {
  if (!/^[0-9]{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digito = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(cnpj.slice(0, 12)) === Number(cnpj[12]) && digito(cnpj.slice(0, 13)) === Number(cnpj[13]);
}

// Recebe so os digitos (11 = CPF, 14 = CNPJ) e confere os digitos verificadores.
function isValidDocumento(doc) {
  if (doc.length === 11) return isValidCpf(doc);
  if (doc.length === 14) return isValidCnpj(doc);
  return false;
}

function isValidBarcode(code) {
  return /^[0-9]{8,14}$/.test(code);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidTelefone(tel) {
  return typeof tel === 'string' && tel.replace(/\D/g, '').length >= 10;
}

// Unidades que so podem ser movimentadas/vendidas em quantidades inteiras.
const UNIDADES_INTEIRAS = ['UN', 'CX'];

function isQuantidadeValidaParaUnidade(quantidade, unidade) {
  return !UNIDADES_INTEIRAS.includes(unidade) || Number.isInteger(Number(quantidade));
}

module.exports = {
  onlyDigits,
  isValidCpf,
  isValidCnpj,
  isValidDocumento,
  isValidBarcode,
  isValidEmail,
  isValidTelefone,
  UNIDADES_INTEIRAS,
  isQuantidadeValidaParaUnidade,
};
