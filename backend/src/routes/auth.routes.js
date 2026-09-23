const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'email e senha sao obrigatorios' });
  }

  const { rows } = await pool.query(
    `SELECT id, tenant_id, nome, email, senha_hash, perfil, location_id, ativo
     FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.ativo) {
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }

  const ok = await bcrypt.compare(senha, user.senha_hash);
  if (!ok) {
    return res.status(401).json({ erro: 'Credenciais invalidas' });
  }

  const token = jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenant_id,
      perfil: user.perfil,
      locationId: user.location_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({
    token,
    usuario: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      perfil: user.perfil,
      locationId: user.location_id,
    },
  });
});

module.exports = router;
