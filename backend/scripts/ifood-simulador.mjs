// Simulador local da API do iFood (so desenvolvimento/testes). Imita o necessario do fluxo real:
// vinculo da loja (userCode -> autorizar -> token), lojas, eventos por polling + ACK, detalhe do pedido,
// confirmar / iniciar preparo / pronto / despachar, motivos e pedido de cancelamento, negociacao (disputa).
//
// Uso:
//   npm run ifood:simulador                        # porta 4999 (SIM_PORT muda)
//   no backend/.env:  IFOOD_API_URL=http://localhost:4999  IFOOD_CLIENT_ID=sim  IFOOD_CLIENT_SECRET=sim
//
// Controle do simulador (fazer de conta que um cliente pediu no app):
//   POST /_sim/pedidos {"merchantId":"sim-loja-1","itens":[{"nome":"X-Burguer","codigo":"PRD-0004","quantidade":1,"preco":25}]}
//   GET  /_sim/autorizar?userCode=XXXX      -> mostra o codigo de autorizacao (o "Portal do Parceiro")
//   POST /_sim/pedidos/{id}/cancelar-cliente | /disputa | /concluir
//   GET  /_sim/acoes                         -> o que o GiroStock chamou (confirm, startPreparation...)
import http from 'node:http';
import { createRequire } from 'node:module';

const { criarSimulador } = createRequire(import.meta.url)('../src/integracoes/simulados/ifood.js');
const PORTA = Number(process.env.SIM_PORT || 4999);
const BASE = `http://localhost:${PORTA}`;
const LOJAS = Number(process.env.SIM_LOJAS || 1) > 1
  ? [{ id: 'sim-loja-1', name: 'Lanchonete Simulada (Centro)' }, { id: 'sim-loja-2', name: 'Lanchonete Simulada (Bairro)' }]
  : [{ id: 'sim-loja-1', name: 'Lanchonete Simulada' }];
const sim = criarSimulador({ base: BASE, lojas: LOJAS });

function lerCorpo(req) {
  return new Promise((ok) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const t = Buffer.concat(partes).toString('utf8');
      if (!t) return ok({});
      if ((req.headers['content-type'] || '').includes('x-www-form-urlencoded')) return ok(Object.fromEntries(new URLSearchParams(t)));
      try { ok(JSON.parse(t)); } catch { ok({}); }
    });
  });
}

http.createServer(async (req, res) => {
  const r = await sim.atender(req.method, req.url, req.headers, await lerCorpo(req));
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(r.corpo === null || r.corpo === undefined ? '' : JSON.stringify(r.corpo));
}).listen(PORTA, () => console.log(`Simulador do iFood em ${BASE} (lojas: ${LOJAS.map((l) => l.id).join(', ')})`));
