require('dotenv').config();
const app = require('./app');
const monitoramento = require('./services/monitoramento');
const backup = require('./services/backup');
const suporte = require('./services/suporte');
const ifood = require('./integracoes/ifood/servico');
const lojaVirtual = require('./services/lojaVirtual');

const port = process.env.PORT || 3000;
monitoramento.iniciarLimpezaDiaria();
backup.iniciarAgendador();
suporte.iniciarVarredura();
ifood.iniciarPolling(); // pedidos do iFood a cada 30 s (so com IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET configurados)
lojaVirtual.iniciarVarredura(); // loja virtual: confere Pix/cartão pendentes e cancela os não pagos no prazo (a cada 60 s)
app.listen(port, () => {
  console.log(`GiroStock API rodando na porta ${port}`);
});
