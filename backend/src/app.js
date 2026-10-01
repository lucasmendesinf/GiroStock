const express = require('express');
// Faz o Express 4 encaminhar erros de handlers async ao middleware de erro.
// Sem isso, qualquer erro do banco (ex: id invalido) derrubava o processo inteiro.
require('express-async-errors');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const { authRequired } = require('./middleware/auth');
const { mapPgError } = require('./utils/http');

const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const suppliersRoutes = require('./routes/suppliers.routes');
const productsRoutes = require('./routes/products.routes');
const stockRoutes = require('./routes/stock.routes');
const ingredientsRoutes = require('./routes/ingredients.routes');
const locationsRoutes = require('./routes/locations.routes');
const cashRoutes = require('./routes/cash.routes');
const salesRoutes = require('./routes/sales.routes');
const reportsRoutes = require('./routes/reports.routes');

const app = express();

// CSP desabilitado: o frontend carrega a fonte do Google Fonts (cross-origin)
// e este e um sistema interno, nao uma pagina publica renderizando conteudo de terceiros.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);

app.use('/api', authRequired, usersRoutes);
app.use('/api', authRequired, suppliersRoutes);
app.use('/api', authRequired, productsRoutes);
app.use('/api', authRequired, stockRoutes);
app.use('/api', authRequired, ingredientsRoutes);
app.use('/api', authRequired, locationsRoutes);
app.use('/api', authRequired, cashRoutes);
app.use('/api', authRequired, salesRoutes);
app.use('/api', authRequired, reportsRoutes);

// Serve o build do frontend (frontend/dist) quando presente, permitindo rodar
// backend + frontend como um unico processo Node (ex: cPanel Node.js Selector,
// sem Docker/Nginx). Em desenvolvimento local o Vite dev server continua
// separado e essa pasta simplesmente nao existe.
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((req, res) => {
  res.status(404).json({ erro: 'rota nao encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) {
    // HttpError das rotas ou JSON malformado no corpo (body-parser)
    const erro = err.type === 'entity.parse.failed' ? 'corpo da requisicao nao e um JSON valido' : err.message;
    return res.status(err.status).json({ erro });
  }
  const mapped = mapPgError(err);
  if (mapped) return res.status(mapped.status).json({ erro: mapped.erro });
  console.error(err);
  res.status(500).json({ erro: 'erro interno do servidor' });
});

module.exports = app;
