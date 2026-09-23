require('dotenv').config();
const app = require('./app');

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`GiroStock API rodando na porta ${port}`);
});
