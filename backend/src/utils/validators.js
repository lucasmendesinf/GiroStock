function isValidDocumento(doc) {
  return /^[0-9]{11}$/.test(doc) || /^[0-9]{14}$/.test(doc);
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

module.exports = { isValidDocumento, isValidBarcode, isValidEmail, isValidTelefone };
