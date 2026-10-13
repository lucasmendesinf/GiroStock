require('dotenv').config();
const app = require('./app');
const monitoramento = require('./services/monitoramento');
const backup = require('./services/backup');
const suporte = require('./services/suporte');

const port = process.env.PORT || 3000;
monitoramento.iniciarLimpezaDiaria();
backup.iniciarAgendador();
suporte.iniciarVarredura();
app.listen(port, () => {
  console.log(`GiroStock API rodando na porta ${port}`);
});
