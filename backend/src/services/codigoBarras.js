// Codigo de barras interno (EAN-13 com prefixo 2 = faixa reservada a uso da propria loja), usado nos combos.
const crypto = require('crypto');
const { HttpError } = require('../utils/http');

// Digito verificador do EAN-13: pesos 1 e 3 sobre os 12 primeiros digitos.
function digitoEan13(doze) {
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += Number(doze[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (soma % 10)) % 10;
}

// 13 digitos: "2" + 11 digitos aleatorios (crypto.randomInt) + verificador. Sem consulta ao banco.
function novoCodigoInterno() {
  let corpo = '2';
  for (let i = 0; i < 11; i++) corpo += String(crypto.randomInt(0, 10));
  return corpo + digitoEan13(corpo);
}

function eanValido(codigo) {
  return /^[0-9]{13}$/.test(codigo) && digitoEan13(codigo.slice(0, 12)) === Number(codigo[12]);
}

// Codigo livre na empresa: nem em products.barcode nem em produto_faixas.ean_pack. Tenta ate 20 vezes.
async function gerarCodigoBarrasInterno(db, tenantId) {
  for (let i = 0; i < 20; i++) {
    const codigo = novoCodigoInterno();
    const { rows } = await db.query(
      `SELECT 1 FROM products WHERE tenant_id = $1 AND barcode = $2
       UNION ALL SELECT 1 FROM produto_faixas WHERE tenant_id = $1 AND ativo AND ean_pack = $2 LIMIT 1`,
      [tenantId, codigo]
    );
    if (rows.length === 0) return codigo;
  }
  throw new HttpError(500, 'não foi possível gerar um código de barras livre; tente de novo');
}

module.exports = { digitoEan13, novoCodigoInterno, eanValido, gerarCodigoBarrasInterno };
