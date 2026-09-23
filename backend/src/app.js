const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { authRequired } = require('./middleware/auth');

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

app.use(helmet());
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

app.use((req, res) => {
  res.status(404).json({ erro: 'rota nao encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'erro interno do servidor' });
});

module.exports = app;
