// Limite simples de tentativas por chave (ex.: IP + rota), em memoria. Protege login, cadastro e recuperacao de senha
// das contas da loja virtual contra forca bruta. Reinicia junto com o app (suficiente para uma instancia).
const janelas = new Map();

// max tentativas a cada `janelaMs`. Devolve um middleware que responde 429 ao passar do limite.
function limitar(nome, max, janelaMs) {
  return (req, res, next) => {
    // fora da producao, os testes automatizados simulam visitantes diferentes pelo cabecalho x-teste-ip
    const ip = (process.env.NODE_ENV !== 'production' && req.get('x-teste-ip')) || req.ip;
    const chave = `${nome}:${ip}`;
    const agora = Date.now();
    let j = janelas.get(chave);
    if (!j || agora - j.inicio > janelaMs) {
      j = { inicio: agora, n: 0 };
      janelas.set(chave, j);
    }
    j.n += 1;
    if (j.n > max) {
      res.set('Retry-After', String(Math.ceil((j.inicio + janelaMs - agora) / 1000)));
      return res.status(429).json({ erro: 'muitas tentativas: aguarde alguns minutos e tente de novo' });
    }
    return next();
  };
}

// Limpeza das janelas vencidas (evita crescer sem fim).
setInterval(() => {
  const agora = Date.now();
  for (const [k, j] of janelas) if (agora - j.inicio > 3600 * 1000) janelas.delete(k);
}, 10 * 60 * 1000).unref();

const zerar = () => janelas.clear();

module.exports = { limitar, zerar };
