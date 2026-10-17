// Requisicao HTTP(S) simples para as plataformas de delivery (sem dependencias; compativel com Node 14, sem fetch).
const http = require('http');
const https = require('https');
const { URL } = require('url');

class ErroPlataforma extends Error {
  constructor(status, mensagem, corpo) {
    super(mensagem);
    this.status = status; // codigo HTTP da plataforma (0 = sem resposta)
    this.corpo = corpo;
  }
}

// opcoes: { headers, json (corpo JSON), jsonTexto (corpo JSON ja montado), form (objeto -> x-www-form-urlencoded),
//          interpretar (texto -> objeto; padrao JSON.parse), timeoutMs }
// Devolve { status, corpo } (corpo ja interpretado como JSON quando possivel). Erro de rede -> ErroPlataforma(0).
function requisicao(metodo, endereco, opcoes = {}) {
  const url = new URL(endereco);
  const cliente = url.protocol === 'http:' ? http : https;
  const headers = { accept: 'application/json', ...(opcoes.headers || {}) };
  let corpo = null;
  if (opcoes.form) {
    corpo = new URLSearchParams(opcoes.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (opcoes.jsonTexto !== undefined) {
    corpo = opcoes.jsonTexto;
    headers['content-type'] = 'application/json';
  } else if (opcoes.json !== undefined) {
    corpo = JSON.stringify(opcoes.json);
    headers['content-type'] = 'application/json';
  }
  if (corpo !== null) headers['content-length'] = Buffer.byteLength(corpo);
  return new Promise((resolve, reject) => {
    const req = cliente.request(url, { method: metodo, headers, timeout: opcoes.timeoutMs || 15000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let dados = texto;
        if (texto) { try { dados = (opcoes.interpretar || JSON.parse)(texto); } catch { /* texto puro */ } } else dados = null;
        resolve({ status: res.statusCode, corpo: dados });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', (err) => reject(new ErroPlataforma(0, `sem resposta da plataforma: ${err.message}`)));
    if (corpo !== null) req.write(corpo);
    req.end();
  });
}

module.exports = { requisicao, ErroPlataforma };
