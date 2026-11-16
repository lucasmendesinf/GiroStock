// MODO TESTE das integracoes: quando a requisicao (ou o ciclo automatico) roda no banco de teste, o iFood e o WhatsApp
// sao SIMULADOS dentro do proprio servidor (src/integracoes/simulados): nada sai para o iFood nem para a Meta de verdade.
// - iFood: conectar a loja com um clique, gerar pedido de teste, cardapio, disponibilidade, entregador (anda sozinho no mapa).
// - WhatsApp: conectar, avisos do pedido e campanhas; as mensagens ficam numa lista ("mensagens que teriam sido enviadas").
// O estado dos simuladores fica so em memoria (reiniciar o servidor zera as mensagens e os pedidos pendentes do simulador).
const pool = require('../db/pool');
const simIfoodMod = require('./simulados/ifood');
const simWaMod = require('./simulados/whatsapp');

const ativo = () => pool.emTeste();

// tempos do entregador simulado (ms desde a chamada): alocado, a caminho, na loja, coletou, no cliente, entregue
const TEMPOS_ENTREGA = (process.env.TESTE_ENTREGA_MS || '8000,20000,40000,60000,120000,135000').split(',').map(Number);

let ifood = null;
function simIfood() {
  if (!ifood) ifood = simIfoodMod.criarSimulador({ base: 'http://ifood-teste.local', lojas: [], leniente: true, entregaAutomatica: TEMPOS_ENTREGA });
  return ifood;
}
let wa = null;
function simWhatsapp() {
  if (!wa) {
    wa = simWaMod.criarSimulador({
      atrasoMs: Number(process.env.TESTE_WHATSAPP_ATRASO_MS || 1500), lerTudo: true,
      aoStatus: (statuses) => pool.executarEmTeste(() => require('./whatsapp').aplicarStatus(statuses)),
    });
  }
  return wa;
}

const minusculas = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
function corpoDe(opcoes) {
  if (opcoes.json !== undefined) return opcoes.json;
  if (opcoes.form) return { ...opcoes.form };
  if (opcoes.jsonTexto !== undefined) { try { return JSON.parse(opcoes.jsonTexto); } catch { return {}; } }
  return {};
}
// Mesma resposta da requisicao HTTP: { status, corpo }
const chamarIfood = (metodo, caminho, opcoes = {}) => simIfood().atender(metodo, caminho, minusculas(opcoes.headers), corpoDe(opcoes));
const chamarWhatsapp = (metodo, caminho, opcoes = {}) => simWhatsapp().atender(metodo, caminho, minusculas(opcoes.headers), corpoDe(opcoes));

module.exports = { ativo, simIfood, simWhatsapp, chamarIfood, chamarWhatsapp, TEMPOS_ENTREGA };

// Ciclos do modo teste no BANCO DE TESTE (a cada 5 s): pedidos/eventos do iFood simulado, avisos do WhatsApp e campanhas.
// So quando o modo teste esta configurado; erro (ex.: banco de teste ainda nao criado) pausa 1 minuto.
let pausaAte = 0;
let girando = false;
async function cicloTeste() {
  if (girando || Date.now() < pausaAte || !pool.testeConfigurado()) return;
  girando = true;
  try {
    await pool.executarEmTeste(async () => {
      // so se alguem usou o modo teste (ha conexao do iFood ou do WhatsApp no teste)
      const tem = (await pool.query(
        `SELECT EXISTS (SELECT 1 FROM integracoes_delivery WHERE status = 'conectado' AND plataforma = 'ifood') AS ifood,
                EXISTS (SELECT 1 FROM whatsapp_contas WHERE status = 'conectado') AS wa`
      )).rows[0];
      if (tem.ifood) await require('./ifood/servico').cicloGeral();
      if (tem.wa) {
        await require('./whatsapp').varrer();
        await require('./whatsappCampanhas').enviarFila();
        await require('./whatsappCampanhas').rodarAutomacoes();
      }
    });
  } catch (err) {
    pausaAte = Date.now() + 60000;
  } finally {
    girando = false;
  }
}
function iniciarCiclosTeste() {
  const t = setInterval(() => { cicloTeste().catch(() => {}); }, (Number(process.env.TESTE_CICLO_SEGUNDOS) || 5) * 1000);
  if (t.unref) t.unref();
}
module.exports.cicloTeste = cicloTeste;
module.exports.iniciarCiclosTeste = iniciarCiclosTeste;
