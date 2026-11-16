// ZIP minimo (sem dependencias; funciona em Node antigo): arquivos comprimidos com deflate (zlib) e CRC-32 proprio.
// Uso: criarZip([{ nome: 'pasta/arquivo.xml', conteudo: Buffer|string }]) -> Buffer
const zlib = require('zlib');

const TABELA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABELA[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// data/hora no formato do DOS (o que o ZIP guarda)
function dataDos(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const data = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, data };
}

function criarZip(arquivos, quando = new Date()) {
  const { hora, data } = dataDos(quando);
  const partes = [];
  const central = [];
  let offset = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const original = Buffer.isBuffer(a.conteudo) ? a.conteudo : Buffer.from(String(a.conteudo), 'utf8');
    const comprimido = zlib.deflateRawSync(original);
    const crc = crc32(original);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versao
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    partes.push(local, nome, comprimido);
    const cab = Buffer.alloc(46);
    cab.writeUInt32LE(0x02014b50, 0);
    cab.writeUInt16LE(20, 4);
    cab.writeUInt16LE(20, 6);
    cab.writeUInt16LE(0x0800, 8);
    cab.writeUInt16LE(8, 10);
    cab.writeUInt16LE(hora, 12);
    cab.writeUInt16LE(data, 14);
    cab.writeUInt32LE(crc, 16);
    cab.writeUInt32LE(comprimido.length, 20);
    cab.writeUInt32LE(original.length, 24);
    cab.writeUInt16LE(nome.length, 28);
    cab.writeUInt16LE(0, 30); // extra
    cab.writeUInt16LE(0, 32); // comentario
    cab.writeUInt16LE(0, 34); // disco
    cab.writeUInt16LE(0, 36); // atributos internos
    cab.writeUInt32LE(0, 38); // atributos externos
    cab.writeUInt32LE(offset, 42);
    central.push(cab, nome);
    offset += local.length + nome.length + comprimido.length;
  }
  const tamCentral = central.reduce((t, b) => t + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12);
  fim.writeUInt32LE(offset, 16);
  fim.writeUInt16LE(0, 20);
  return Buffer.concat([...partes, ...central, fim]);
}

module.exports = { criarZip, crc32 };
