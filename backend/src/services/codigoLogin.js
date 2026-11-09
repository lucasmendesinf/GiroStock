// Envio do codigo de login do cardapio digital por WhatsApp/SMS. Nao ha provedor fixo: a escolha e do lojista/plataforma
// e vem de variaveis de ambiente (segredos nunca vao para o codigo, log ou resposta).
//   CODIGO_LOGIN_PROVEDOR = simulado | http
//     simulado: nao envia nada; apenas em development/test, devolve o codigo fixo de teste.
//     sandbox de pre-visualizacao: opcao explicita, limitada a um subdominio e telefone de teste.
//     http:     chama uma API de WhatsApp/SMS contratada, configurada so por ambiente:
//       CODIGO_LOGIN_HTTP_URL     endereco (https://...)
//       CODIGO_LOGIN_HTTP_METODO  POST (padrao) ou GET
//       CODIGO_LOGIN_HTTP_CABECALHO  nome do cabecalho de autenticacao (ex.: Authorization)
//       CODIGO_LOGIN_HTTP_TOKEN      valor do cabecalho (ex.: Bearer xxxx)
//       CODIGO_LOGIN_HTTP_CORPO      JSON do corpo, com {telefone} e {mensagem} (padrao: {"telefone":"{telefone}","mensagem":"{mensagem}"})
//       CODIGO_LOGIN_MENSAGEM        texto; usa {loja} e {codigo}
const { HttpError } = require('../utils/http');

const ambienteTeste = () => ['development', 'test'].includes(String(process.env.NODE_ENV || '').trim().toLowerCase());
const CODIGO_TESTE = '12345678';
const MENSAGEM_PADRAO = 'Seu código de acesso à *{loja}* é *{codigo}*. Vale por 10 minutos.';
const digitos = (v) => String(v || '').replace(/\D/g, '');

function sandboxPreviewConfigurado() {
  const subdominio = String(process.env.CODIGO_LOGIN_SANDBOX_SUBDOMINIO || '').trim().toLowerCase();
  const telefone = digitos(process.env.CODIGO_LOGIN_SANDBOX_TELEFONE);
  return process.env.NODE_ENV === 'production'
    && String(process.env.CODIGO_LOGIN_SANDBOX_PREVIA || '').trim().toLowerCase() === 'true'
    && /^[a-z0-9-]{3,63}$/.test(subdominio)
    && /^\d{10,11}$/.test(telefone);
}

function sandboxPreviewAtivo(opcoes = {}) {
  if (!sandboxPreviewConfigurado()) return false;
  const subdominio = String(process.env.CODIGO_LOGIN_SANDBOX_SUBDOMINIO || '').trim().toLowerCase();
  const telefoneTeste = digitos(process.env.CODIGO_LOGIN_SANDBOX_TELEFONE);
  return opcoes.previsualizacao === true
    && String(opcoes.subdominio || '').trim().toLowerCase() === subdominio
    && digitos(opcoes.telefone) === telefoneTeste;
}

function provedor(opcoes = {}) {
  if (sandboxPreviewAtivo(opcoes)) return 'simulado';
  const p = String(process.env.CODIGO_LOGIN_PROVEDOR || '').trim().toLowerCase();
  if (p === 'http') {
    const urlConfigurada = /^https?:\/\//i.test(process.env.CODIGO_LOGIN_HTTP_URL || '');
    // Uma seleção HTTP sem URL não é um provedor disponível; em dev/test, usa o fluxo local sem envio.
    if (ambienteTeste() && !urlConfigurada) return 'simulado';
    return 'http';
  }
  if (p === 'simulado') return p;
  return ambienteTeste() ? 'simulado' : 'nenhum';
}

// Código fixo apenas no modo simulado e quando o ambiente foi explicitamente marcado como dev/test.
function codigoTesteAtivo(opcoes = {}) {
  return sandboxPreviewAtivo(opcoes) || (ambienteTeste() && provedor() === 'simulado');
}

// Status para o painel Master (sem segredos).
function status(opcoes = {}) {
  const sandbox = sandboxPreviewAtivo(opcoes);
  const p = provedor(opcoes);
  if (p === 'simulado') {
    if (sandbox) return { provedor: p, configurado: true, detalhe: 'sandbox da pré-visualização ativo para loja e telefone de teste configurados; nada é enviado' };
    return codigoTesteAtivo()
      ? { provedor: p, configurado: true, detalhe: 'simulado (desenvolvimento/teste): código fixo disponível, nada é enviado' }
      : { provedor: p, configurado: false, detalhe: 'o provedor simulado só funciona em development/test ou no sandbox explícito de pré-visualização' };
  }
  if (p === 'http') {
    const ok = /^https?:\/\//i.test(process.env.CODIGO_LOGIN_HTTP_URL || '');
    return { provedor: p, configurado: ok, detalhe: ok ? 'envio por HTTP configurado' : 'falta CODIGO_LOGIN_HTTP_URL' };
  }
  return { provedor: 'nenhum', configurado: false, detalhe: 'sem provedor: o login por telefone da loja fica indisponível (CODIGO_LOGIN_PROVEDOR)' };
}

// Chamado na inicializacao: avisa de forma clara quando a configuracao impede o login por codigo.
function validarInicializacao() {
  const s = status();
  if (!s.configurado) console.error(`login por código (cardápio): ${s.detalhe}`);
}

const trocar = (modelo, vars) => String(modelo).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
// Valor dentro de um JSON: escapa para nao quebrar o corpo.
const jsonStr = (v) => JSON.stringify(String(v)).slice(1, -1);

// Envia o codigo. O sandbox de producao nunca envia SMS e so vale para o contexto exato configurado.
async function enviar({ telefone, codigo, loja, previsualizacao, subdominio }) {
  const opcoes = { previsualizacao, subdominio, telefone };
  const s = status(opcoes);
  if (!s.configurado) throw new HttpError(503, 'o login por telefone está indisponível no momento: fale com a loja');
  const sandbox = sandboxPreviewAtivo(opcoes);
  if (s.provedor === 'simulado' && !codigoTesteAtivo(opcoes)) throw new HttpError(503, 'o provedor simulado só funciona em desenvolvimento/teste ou no sandbox configurado');
  const mensagem = trocar(process.env.CODIGO_LOGIN_MENSAGEM || MENSAGEM_PADRAO, { loja: String(loja || 'Loja'), codigo });
  if (s.provedor === 'simulado') {
    if (sandbox) console.log('[codigo-login sandbox] código de teste usado na pré-visualização configurada');
    else console.log(`[codigo-login simulado] ${telefone}: ${CODIGO_TESTE}`);
    return { via: sandbox ? 'sandbox' : 'simulado', codigo_teste: CODIGO_TESTE, sandbox_preview: sandbox };
  }
  const destino = `55${telefone}`;
  const metodo = String(process.env.CODIGO_LOGIN_HTTP_METODO || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CODIGO_LOGIN_HTTP_CABECALHO && process.env.CODIGO_LOGIN_HTTP_TOKEN) headers[process.env.CODIGO_LOGIN_HTTP_CABECALHO] = process.env.CODIGO_LOGIN_HTTP_TOKEN;
  const corpoModelo = process.env.CODIGO_LOGIN_HTTP_CORPO || '{"telefone":"{telefone}","mensagem":"{mensagem}"}';
  let url = process.env.CODIGO_LOGIN_HTTP_URL;
  let body;
  if (metodo === 'GET') url = trocar(url, { telefone: encodeURIComponent(destino), mensagem: encodeURIComponent(mensagem) });
  else body = trocar(corpoModelo, { telefone: jsonStr(destino), mensagem: jsonStr(mensagem) });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { method: metodo, headers, body, signal: ctl.signal });
    if (!res.ok) throw new Error(`o provedor respondeu ${res.status}`);
    return { via: 'http' };
  } catch (err) {
    // o codigo nunca entra na mensagem de erro
    console.error('codigo de login: falha no envio:', String(err.message).replace(/\d{6}/g, '******'));
    throw new HttpError(502, 'não foi possível enviar o código; tente de novo');
  } finally {
    clearTimeout(t);
  }
}

module.exports = { provedor, status, enviar, validarInicializacao, codigoTesteAtivo, sandboxPreviewAtivo, sandboxPreviewConfigurado, CODIGO_TESTE };
