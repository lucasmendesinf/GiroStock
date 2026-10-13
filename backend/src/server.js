require('dotenv').config();
const app = require('./app');
const monitoramento = require('./services/monitoramento');

const port = process.env.PORT || 3000;
monitoramento.iniciarLimpezaDiaria();
app.listen(port, () => {
  console.log(`GiroStock API rodando na porta ${port}`);
});
