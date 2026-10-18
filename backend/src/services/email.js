// Envio de e-mail (por enquanto: codigo de recuperacao de senha das contas da loja virtual).
// SMTP pelo .env (no cPanel: o servidor de e-mail da propria hospedagem). Sem SMTP:
//  - producao: indisponivel (a rota responde que a recuperacao por e-mail nao esta configurada);
//  - desenvolvimento/testes: o e-mail e gravado em backend/tmp/emails/*.json (os testes leem o codigo de la).
const fs = require('fs');
const path = require('path');

let transporte = null;
const configurado = () => !!process.env.SMTP_HOST;
const disponivel = () => configurado() || process.env.NODE_ENV !== 'production';
const dirArquivo = () => path.join(__dirname, '..', '..', 'tmp', 'emails');

function obterTransporte() {
  if (!transporte) {
    const nodemailer = require('nodemailer'); // carregado so quando ha SMTP
    const porta = Number(process.env.SMTP_PORT) || 465;
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: porta,
      secure: porta === 465,
      auth: process.env.SMTP_USUARIO ? { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_SENHA || '' } : undefined,
    });
  }
  return transporte;
}

// { para, assunto, texto, html, nomeRemetente }
async function enviar(m) {
  if (configurado()) {
    const remetente = process.env.SMTP_REMETENTE || process.env.SMTP_USUARIO;
    await obterTransporte().sendMail({
      from: m.nomeRemetente ? `"${String(m.nomeRemetente).replace(/"/g, '')}" <${remetente}>` : remetente,
      to: m.para, subject: m.assunto, text: m.texto, html: m.html,
    });
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('e-mail não configurado (SMTP_HOST)');
  fs.mkdirSync(dirArquivo(), { recursive: true });
  fs.writeFileSync(path.join(dirArquivo(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ ...m, em: new Date().toISOString() }, null, 2));
}

module.exports = { enviar, disponivel, configurado, dirArquivo };
