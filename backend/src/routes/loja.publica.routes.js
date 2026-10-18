// API publica da loja virtual (/api/loja/v1): usada pelo site da loja (projeto separado, o mesmo para todas as empresas).
// Toda chamada leva o cabecalho X-Loja-Chave (chave gerada em Loja virtual > Configuração). As rotas da conta e dos
// pedidos levam tambem o token do cliente (Authorization: Bearer ...), recebido no cadastro/login.
// Documentacao: docs/API_LOJA_VIRTUAL.md
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const lv = require('../services/lojaVirtual');
const email = require('../services/email');
const { criarPedido } = require('../services/pedidos');
const { usuarioSistema } = require('../integracoes/comum');
const { inserirCliente } = require('./customers.routes');
const { HttpError } = require('../utils/http');
const { isUuid } = require('../utils/tenant');
const { limitar } = require('../utils/limitador');

const router = express.Router();
const db = lv.db;
const texto = (v, max = 120) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const digitos = (v) => String(v || '').replace(/\D/g, '');

// Endereco publico deste servidor (links de imagem e aviso do Mercado Pago).
const baseUrl = (req) => (process.env.URL_PUBLICA || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// ---------- imagens (sem chave: usadas direto em <img>; o id e imprevisivel e a imagem nunca muda) ----------
router.get('/imagens/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'imagem não encontrada');
  const { rows } = await db().query(`SELECT mime, dados FROM lv_imagens WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) throw new HttpError(404, 'imagem não encontrada');
  res.set('Content-Type', rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(rows[0].dados);
});

// ---------- chave da loja ----------
router.use(async (req, res, next) => {
  req.loja = await lv.lojaPorChave(req.get('x-loja-chave'));
  next();
});

// ---------- conta do cliente (token) ----------
const segredo = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET)).update('girostock-loja-virtual').digest('hex');
const VALIDADE_TOKEN = '30d';

function emitirToken(conta) {
  return jwt.sign({ sub: conta.id, t: conta.tenant_id, tipo: 'loja' }, segredo(), { expiresIn: VALIDADE_TOKEN });
}

async function contaDoToken(req, obrigatorio = true) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) { if (obrigatorio) throw new HttpError(401, 'entre na sua conta'); return null; }
  let p;
  try {
    p = jwt.verify(token, segredo());
  } catch {
    throw new HttpError(401, 'sessão expirada: entre de novo');
  }
  if (p.tipo !== 'loja' || p.t !== req.loja.tenant_id) throw new HttpError(401, 'sessão inválida: entre de novo');
  const { rows } = await db().query(`SELECT * FROM lv_contas WHERE id = $1 AND tenant_id = $2`, [p.sub, req.loja.tenant_id]);
  const c = rows[0];
  if (!c || !c.ativo) throw new HttpError(401, 'conta desativada');
  if (p.iat * 1000 < new Date(c.sessoes_validas_desde).getTime() - 1000) throw new HttpError(401, 'sessão encerrada: entre de novo');
  return c;
}
const comConta = async (req, res, next) => { req.conta = await contaDoToken(req); next(); };

function contaPublica(c) {
  return { id: c.id, nome: c.nome, email: c.email, telefone: c.telefone, cpf: c.cpf, aceita_mensagens: c.aceita_mensagens, criado_em: c.criado_em };
}

function validarEmail(v) {
  const e = texto(v, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, 'e-mail inválido');
  return e;
}
function validarSenha(v) {
  const s = String(v || '');
  if (s.length < 8 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new HttpError(400, 'a senha precisa de ao menos 8 caracteres, com letras e números');
  if (s.length > 100) throw new HttpError(400, 'senha longa demais');
  return s;
}
function validarTelefone(v) {
  const t = digitos(v);
  if (t.length < 10 || t.length > 11) throw new HttpError(400, 'telefone inválido: informe o DDD e o número');
  return t;
}
function validarCpf(v) {
  const c = digitos(v);
  if (!c) return null;
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) throw new HttpError(400, 'CPF inválido');
  const dv = (base) => { let s = 0; for (let i = 0; i < base.length; i++) s += Number(base[i]) * (base.length + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  if (dv(c.slice(0, 9)) !== Number(c[9]) || dv(c.slice(0, 10)) !== Number(c[10])) throw new HttpError(400, 'CPF inválido');
  return c;
}

// Cliente do sistema (tela Clientes) pelo telefone: vincula ao existente ou cadastra.
async function clienteDoSistema(client, tenantId, nome, telefone, aceita) {
  const ex = await client.query(`SELECT id FROM customers WHERE tenant_id = $1 AND telefone = $2`, [tenantId, telefone]);
  if (ex.rows.length > 0) return ex.rows[0].id;
  return inserirCliente(client, tenantId, { nome, telefone, aceita_mensagens: aceita, consentimento_origem: 'loja_virtual' });
}

// ---------- loja ----------
router.get('/loja', async (req, res) => {
  res.json(await lv.dadosPublicos(req.loja, baseUrl(req)));
});

router.get('/categorias', async (req, res) => {
  res.json(await lv.categorias(req.loja));
});

router.get('/produtos', async (req, res) => {
  const q = req.query;
  if (q.categoria && !isUuid(q.categoria)) throw new HttpError(400, 'categoria inválida');
  res.json(await lv.catalogo(req.loja, baseUrl(req), {
    categoria: q.categoria || null, busca: q.busca || null, destaque: q.destaque === 'true' || q.destaque === '1',
    pagina: q.pagina, por_pagina: q.por_pagina, ordem: q.ordem,
  }));
});

router.get('/produtos/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'produto não encontrado');
  res.json(await lv.produto(req.loja, baseUrl(req), req.params.id));
});

// Previa do carrinho: precos, taxa de entrega, cupom, minimo e estoque (problemas viram "avisos").
router.post('/carrinho', async (req, res) => {
  const conta = await contaDoToken(req, false);
  const b = req.body || {};
  let bairro = b.bairro || null;
  if (b.endereco_id && conta) {
    const e = (await db().query(`SELECT bairro FROM lv_enderecos WHERE id = $1 AND conta_id = $2`, [b.endereco_id, conta.id])).rows[0];
    if (e) bairro = e.bairro;
  }
  const r = await lv.calcularCarrinho(db(), req.loja, conta, { ...b, bairro }, 'previa');
  const situacao = lv.recebendoPedidos(req.loja);
  if (!situacao.ok) { r.avisos.unshift(situacao.motivo); r.pode_finalizar = false; }
  const { linhas, ...resto } = r; // eslint-disable-line no-unused-vars
  res.json(resto);
});

// ---------- conta ----------
router.post('/conta/cadastro', limitar('lv-cadastro', 10, 3600 * 1000), async (req, res) => {
  const b = req.body || {};
  const nome = texto(b.nome, 120);
  if (nome.length < 3) throw new HttpError(400, 'informe seu nome completo');
  const mail = validarEmail(b.email);
  const telefone = validarTelefone(b.telefone);
  const cpf = validarCpf(b.cpf);
  const senha = validarSenha(b.senha);
  const aceita = !!b.aceita_mensagens;
  const hash = await bcrypt.hash(senha, 10);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const ex = await client.query(`SELECT 1 FROM lv_contas WHERE tenant_id = $1 AND lower(email) = $2`, [req.loja.tenant_id, mail]);
    if (ex.rows.length > 0) throw new HttpError(409, 'já existe uma conta com este e-mail: entre ou recupere a senha');
    const customerId = await clienteDoSistema(client, req.loja.tenant_id, nome, telefone, aceita);
    const { rows } = await client.query(
      `INSERT INTO lv_contas (tenant_id, customer_id, nome, email, telefone, cpf, senha_hash, aceita_mensagens, ultimo_login_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING *`,
      [req.loja.tenant_id, customerId, nome, mail, telefone, cpf, hash, aceita]
    );
    await client.query('COMMIT');
    res.status(201).json({ token: emitirToken(rows[0]), conta: contaPublica(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new HttpError(409, 'já existe uma conta com este e-mail: entre ou recupere a senha');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/conta/login', limitar('lv-login', 20, 10 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const mail = texto(b.email, 160).toLowerCase();
  const { rows } = await db().query(`SELECT * FROM lv_contas WHERE tenant_id = $1 AND lower(email) = $2`, [req.loja.tenant_id, mail]);
  const c = rows[0];
  const ok = c && c.ativo && (await bcrypt.compare(String(b.senha || ''), c.senha_hash));
  if (!ok) throw new HttpError(401, 'e-mail ou senha incorretos');
  await db().query(`UPDATE lv_contas SET ultimo_login_em = now() WHERE id = $1`, [c.id]);
  res.json({ token: emitirToken(c), conta: contaPublica(c) });
});

// Recuperacao: codigo de 6 digitos por e-mail (vale 15 minutos, 5 tentativas). Resposta igual exista ou nao a conta.
router.post('/conta/esqueci-senha', limitar('lv-esqueci', 5, 15 * 60 * 1000), async (req, res) => {
  if (!email.disponivel()) throw new HttpError(503, 'recuperação de senha por e-mail indisponível: fale com a loja');
  const mail = validarEmail((req.body || {}).email);
  const c = (await db().query(`SELECT * FROM lv_contas WHERE tenant_id = $1 AND lower(email) = $2 AND ativo`, [req.loja.tenant_id, mail])).rows[0];
  if (c) {
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db().query(
      `UPDATE lv_contas SET reset_codigo_hash = $2, reset_expira_em = now() + interval '15 minutes', reset_tentativas = 0 WHERE id = $1`,
      [c.id, crypto.createHash('sha256').update(`${c.id}:${codigo}`).digest('hex')]
    );
    const loja = req.loja.nome || 'Loja';
    try {
      await email.enviar({
        para: c.email, nomeRemetente: loja, assunto: `${loja}: código para criar uma nova senha`,
        texto: `Olá, ${c.nome.split(' ')[0]}!\n\nSeu código para criar uma nova senha é: ${codigo}\nEle vale por 15 minutos.\n\nSe não foi você que pediu, ignore este e-mail.\n\n${loja}`,
        codigo: process.env.NODE_ENV === 'production' ? undefined : codigo,
      });
    } catch (err) {
      console.error('loja virtual: e-mail de recuperação', err.message);
      throw new HttpError(503, 'não foi possível enviar o e-mail agora: tente de novo em alguns minutos');
    }
  }
  res.status(202).json({ mensagem: 'se houver uma conta com este e-mail, enviamos um código para criar uma nova senha' });
});

router.post('/conta/redefinir-senha', limitar('lv-redefinir', 20, 15 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const mail = validarEmail(b.email);
  const senha = validarSenha(b.senha);
  const generico = new HttpError(400, 'código inválido ou expirado: peça um novo');
  const c = (await db().query(`SELECT * FROM lv_contas WHERE tenant_id = $1 AND lower(email) = $2 AND ativo`, [req.loja.tenant_id, mail])).rows[0];
  if (!c || !c.reset_codigo_hash || new Date(c.reset_expira_em) < new Date() || c.reset_tentativas >= 5) throw generico;
  const h = crypto.createHash('sha256').update(`${c.id}:${digitos(b.codigo)}`).digest('hex');
  if (h !== c.reset_codigo_hash) {
    await db().query(`UPDATE lv_contas SET reset_tentativas = reset_tentativas + 1 WHERE id = $1`, [c.id]);
    throw generico;
  }
  const { rows } = await db().query(
    `UPDATE lv_contas SET senha_hash = $2, reset_codigo_hash = NULL, reset_expira_em = NULL, reset_tentativas = 0, sessoes_validas_desde = now() - interval '1 second', ultimo_login_em = now()
     WHERE id = $1 RETURNING *`,
    [c.id, await bcrypt.hash(senha, 10)]
  );
  res.json({ token: emitirToken(rows[0]), conta: contaPublica(rows[0]) });
});

router.get('/conta', comConta, async (req, res) => {
  res.json(contaPublica(req.conta));
});

router.put('/conta', comConta, async (req, res) => {
  const b = req.body || {};
  const c = req.conta;
  const nome = b.nome === undefined ? c.nome : texto(b.nome, 120);
  if (nome.length < 3) throw new HttpError(400, 'informe seu nome completo');
  const telefone = b.telefone === undefined ? c.telefone : validarTelefone(b.telefone);
  const cpf = b.cpf === undefined ? c.cpf : validarCpf(b.cpf);
  const aceita = b.aceita_mensagens === undefined ? c.aceita_mensagens : !!b.aceita_mensagens;
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const customerId = telefone !== c.telefone || !c.customer_id ? await clienteDoSistema(client, c.tenant_id, nome, telefone, aceita) : c.customer_id;
    const { rows } = await client.query(
      `UPDATE lv_contas SET nome = $2, telefone = $3, cpf = $4, aceita_mensagens = $5, customer_id = $6 WHERE id = $1 RETURNING *`,
      [c.id, nome, telefone, cpf, aceita, customerId]
    );
    await client.query('COMMIT');
    res.json(contaPublica(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.put('/conta/senha', comConta, limitar('lv-senha', 10, 15 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  if (!(await bcrypt.compare(String(b.senha_atual || ''), req.conta.senha_hash))) throw new HttpError(400, 'senha atual incorreta');
  const nova = validarSenha(b.nova_senha);
  // Troca de senha encerra as outras sessoes; esta recebe um token novo.
  const { rows } = await db().query(
    `UPDATE lv_contas SET senha_hash = $2, sessoes_validas_desde = now() - interval '1 second' WHERE id = $1 RETURNING *`,
    [req.conta.id, await bcrypt.hash(nova, 10)]
  );
  res.json({ token: emitirToken(rows[0]) });
});

// Excluir a conta (LGPD): apaga os dados pessoais da conta e os enderecos; os pedidos continuam no historico da loja.
router.delete('/conta', comConta, async (req, res) => {
  const b = req.body || {};
  if (!(await bcrypt.compare(String(b.senha || ''), req.conta.senha_hash))) throw new HttpError(400, 'senha incorreta');
  await db().query(`DELETE FROM lv_enderecos WHERE conta_id = $1`, [req.conta.id]);
  await db().query(
    `UPDATE lv_contas SET ativo = false, nome = 'Conta excluída', email = 'excluida-' || id || '@excluida.local', telefone = '', cpf = NULL,
            senha_hash = '-', aceita_mensagens = false, sessoes_validas_desde = now() WHERE id = $1`,
    [req.conta.id]
  );
  res.status(204).end();
});

// ---------- enderecos ----------
function dadosEndereco(b, atual = {}) {
  const v = (k, max) => (b[k] === undefined ? atual[k] || '' : texto(b[k], max));
  const e = {
    rotulo: v('rotulo', 30) || 'Casa', cep: digitos(b.cep === undefined ? atual.cep : b.cep).slice(0, 8), logradouro: v('logradouro', 150), numero: v('numero', 20),
    complemento: v('complemento', 80), bairro: v('bairro', 80), cidade: v('cidade', 80), uf: v('uf', 2).toUpperCase(), referencia: v('referencia', 150),
  };
  if (e.logradouro.length < 3) throw new HttpError(400, 'informe a rua');
  if (!e.numero) throw new HttpError(400, 'informe o número (ou "s/n")');
  if (e.bairro.length < 2) throw new HttpError(400, 'informe o bairro');
  if (e.cep && e.cep.length !== 8) throw new HttpError(400, 'CEP inválido');
  return e;
}
const enderecoTexto = (e) => `${e.logradouro}, ${e.numero}${e.complemento ? ` - ${e.complemento}` : ''} - ${e.bairro}${e.cidade ? `, ${e.cidade}${e.uf ? `/${e.uf}` : ''}` : ''}${e.referencia ? ` (Ref.: ${e.referencia})` : ''}`;

async function listarEnderecos(contaId) {
  return (await db().query(`SELECT * FROM lv_enderecos WHERE conta_id = $1 ORDER BY padrao DESC, criado_em`, [contaId])).rows;
}

router.get('/conta/enderecos', comConta, async (req, res) => {
  res.json(await listarEnderecos(req.conta.id));
});

router.post('/conta/enderecos', comConta, async (req, res) => {
  const e = dadosEndereco(req.body || {});
  const qtd = Number((await db().query(`SELECT COUNT(*) AS n FROM lv_enderecos WHERE conta_id = $1`, [req.conta.id])).rows[0].n);
  if (qtd >= 20) throw new HttpError(400, 'limite de 20 endereços');
  const padrao = qtd === 0 || !!(req.body || {}).padrao;
  if (padrao) await db().query(`UPDATE lv_enderecos SET padrao = false WHERE conta_id = $1`, [req.conta.id]);
  const { rows } = await db().query(
    `INSERT INTO lv_enderecos (conta_id, rotulo, cep, logradouro, numero, complemento, bairro, cidade, uf, referencia, padrao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [req.conta.id, e.rotulo, e.cep, e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.uf, e.referencia, padrao]
  );
  res.status(201).json(rows[0]);
});

async function enderecoDaConta(contaId, id) {
  if (!isUuid(id)) throw new HttpError(404, 'endereço não encontrado');
  const e = (await db().query(`SELECT * FROM lv_enderecos WHERE id = $1 AND conta_id = $2`, [id, contaId])).rows[0];
  if (!e) throw new HttpError(404, 'endereço não encontrado');
  return e;
}

router.put('/conta/enderecos/:id', comConta, async (req, res) => {
  const atual = await enderecoDaConta(req.conta.id, req.params.id);
  const e = dadosEndereco(req.body || {}, atual);
  if ((req.body || {}).padrao === true) await db().query(`UPDATE lv_enderecos SET padrao = false WHERE conta_id = $1`, [req.conta.id]);
  const { rows } = await db().query(
    `UPDATE lv_enderecos SET rotulo = $2, cep = $3, logradouro = $4, numero = $5, complemento = $6, bairro = $7, cidade = $8, uf = $9, referencia = $10,
            padrao = CASE WHEN $11 THEN true ELSE padrao END WHERE id = $1 RETURNING *`,
    [atual.id, e.rotulo, e.cep, e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.uf, e.referencia, (req.body || {}).padrao === true]
  );
  res.json(rows[0]);
});

router.delete('/conta/enderecos/:id', comConta, async (req, res) => {
  const atual = await enderecoDaConta(req.conta.id, req.params.id);
  await db().query(`DELETE FROM lv_enderecos WHERE id = $1`, [atual.id]);
  if (atual.padrao) await db().query(`UPDATE lv_enderecos SET padrao = true WHERE id = (SELECT id FROM lv_enderecos WHERE conta_id = $1 ORDER BY criado_em LIMIT 1)`, [req.conta.id]);
  res.status(204).end();
});

// ---------- pedidos ----------
const ETAPAS = {
  aguardando_pagamento: 'Aguardando pagamento',
  recebido: 'Pedido recebido',
  em_preparo: 'Em preparo',
  pronto_retirada: 'Pronto para retirada',
  pronto: 'Pronto, aguardando o entregador',
  saiu_entrega: 'Saiu para entrega',
  entregue: 'Entregue',
  retirado: 'Retirado',
  cancelado: 'Cancelado',
};
function etapa(o) {
  if (o.status === 'novo' && o.pagamento_online && o.pagamento_status !== 'aprovado') return 'aguardando_pagamento';
  if (o.status === 'novo') return 'recebido';
  if (o.status === 'pronto') return o.tipo === 'entrega' ? 'pronto' : 'pronto_retirada';
  if (o.status === 'finalizado') return o.tipo === 'entrega' ? 'entregue' : 'retirado';
  return o.status;
}

async function pedidoPublico(loja, orderId, contaId, base) {
  const o = (await db().query(
    `SELECT o.*, COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) AS subtotal
     FROM orders o WHERE o.id = $1 AND o.tenant_id = $2 AND o.origem = 'loja_virtual' AND o.lv_conta_id = $3`,
    [orderId, loja.tenant_id, contaId]
  )).rows[0];
  if (!o) throw new HttpError(404, 'pedido não encontrado');
  const itens = (await db().query(
    `SELECT oi.product_id, COALESCE(lp.nome_site, p.nome) AS nome, oi.quantidade, oi.preco_unitario, oi.subtotal, oi.observacao, oi.complementos, lp.imagens
     FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN lv_produtos lp ON lp.product_id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`,
    [o.id]
  )).rows;
  const log = (await db().query(`SELECT para, criado_em FROM order_status_log WHERE order_id = $1 ORDER BY criado_em`, [o.id])).rows;
  const pagamento = (await db().query(`SELECT * FROM lv_pagamentos WHERE order_id = $1 AND status <> 'criando' ORDER BY criado_em DESC LIMIT 1`, [o.id])).rows[0];
  const e = etapa(o);
  const n2 = lv.n2;
  const previsto = o.tipo === 'entrega' ? loja.tempo_preparo_min + loja.tempo_entrega_min : loja.tempo_preparo_min;
  return {
    id: o.id,
    numero: o.numero,
    etapa: e,
    etapa_nome: ETAPAS[e] || e,
    tipo: o.tipo,
    endereco: o.tipo === 'entrega' ? o.endereco : null,
    itens: itens.map((i) => ({
      product_id: i.product_id, nome: i.nome, quantidade: Number(i.quantidade), preco_unitario: n2(i.preco_unitario), subtotal: n2(i.subtotal), observacao: i.observacao,
      complementos: (i.complementos || []).map((c) => ({ nome: c.nome, quantidade: c.quantidade, preco: n2(c.preco) })),
      imagem: i.imagens && i.imagens[0] ? lv.urlImagem(base, i.imagens[0]) : null,
    })),
    subtotal: n2(o.subtotal),
    taxa_entrega: n2(o.taxa_entrega),
    desconto: n2(o.desconto),
    total: n2(Number(o.subtotal) + Number(o.taxa_entrega) - Number(o.desconto)),
    cupom: o.cupom_codigo,
    observacao: o.observacao,
    pagamento: o.pagamento_online
      ? { tipo: 'online', metodo: o.pagamento_online, situacao: o.pagamento_status, detalhe: lv.pagamentoPublico(pagamento) }
      : { tipo: 'na_entrega', forma: o.forma_pagamento_prevista, troco_para: o.troco_para === null ? null : n2(o.troco_para), situacao: o.pago ? 'pago' : 'a_pagar' },
    historico: log.map((l) => ({ etapa: l.para === 'novo' ? 'recebido' : l.para, em: l.criado_em })),
    criado_em: o.criado_em,
    previsao_min: ['finalizado', 'cancelado'].includes(o.status) ? null : previsto,
    cancelado_em: o.cancelado_em,
    motivo_cancelamento: o.status === 'cancelado' ? o.motivo_cancelamento : null,
    pode_cancelar: o.status === 'novo',
    pode_pagar: o.status === 'novo' && !!o.pagamento_online && o.pagamento_status !== 'aprovado',
  };
}
const urlAviso = (req) => `${baseUrl(req)}/api/webhooks/mercadopago/${req.loja.id}`;

router.post('/pedidos', comConta, limitar('lv-pedido', 30, 10 * 60 * 1000), async (req, res) => {
  const loja = req.loja;
  const conta = req.conta;
  const b = req.body || {};
  const situacao = lv.recebendoPedidos(loja);
  if (!situacao.ok) throw new HttpError(409, situacao.motivo);
  const pag = b.pagamento || {};
  const metodo = pag.metodo;
  if (!['pix', 'cartao', 'na_entrega'].includes(metodo)) throw new HttpError(400, 'escolha a forma de pagamento');
  const cfgPag = loja.pagamentos || {};
  const mpOk = !!(loja.mp_access_token_cript && loja.mp_public_key);
  if (metodo === 'pix' && !(cfgPag.pix_online && mpOk)) throw new HttpError(422, 'esta loja não aceita Pix pelo site');
  if (metodo === 'cartao' && !(cfgPag.cartao_online && mpOk)) throw new HttpError(422, 'esta loja não aceita cartão pelo site');
  let formaEntrega = null;
  if (metodo === 'na_entrega') {
    formaEntrega = pag.forma;
    if (!['dinheiro', 'pix', 'cartao'].includes(formaEntrega) || !(cfgPag.na_entrega || []).includes(formaEntrega)) throw new HttpError(422, 'forma de pagamento na entrega não aceita por esta loja');
  }
  const tipo = b.tipo === 'entrega' ? 'entrega' : 'retirada';
  let endereco = null;
  if (tipo === 'entrega') {
    if (!b.endereco_id) throw new HttpError(400, 'escolha o endereço da entrega');
    endereco = await enderecoDaConta(conta.id, b.endereco_id);
  }

  const client = await db().connect();
  let pedido;
  try {
    await client.query('BEGIN');
    const c = await lv.calcularCarrinho(client, loja, conta, { ...b, tipo, bairro: endereco ? endereco.bairro : null }, 'pedido');
    let troco = null;
    if (formaEntrega === 'dinheiro' && pag.troco_para !== undefined && pag.troco_para !== null && pag.troco_para !== '') {
      troco = lv.n2(pag.troco_para);
      if (!(troco >= c.total)) throw new HttpError(400, 'o troco precisa ser para um valor maior ou igual ao total');
    }
    const obs = [texto(b.observacao, 250), troco ? `Troco para R$ ${troco.toFixed(2).replace('.', ',')}` : ''].filter(Boolean).join(' · ');
    const user = await usuarioSistema(loja.tenant_id);
    const r = await criarPedido(client, user, {
      location_id: loja.location_id, origem: 'loja_virtual', tipo,
      endereco: endereco ? enderecoTexto(endereco) : '', taxa_entrega: c.taxa_entrega, desconto: c.desconto, observacao: obs,
      forma_pagamento_prevista: metodo === 'na_entrega' ? formaEntrega : null, pago: false,
      cliente_nome: conta.nome, cliente_telefone: conta.telefone,
      itens: c.linhas.map((l) => ({ product_id: l.product_id, quantidade: l.quantidade, observacao: l.observacao, preco_unitario: l.preco_unitario, complementos: l.complementos_pedidos })),
    }, {
      loja: {
        customerId: conta.customer_id, contaId: conta.id, cupomId: c.cupom ? c.cupom.id : null, cupomCodigo: c.cupom ? c.cupom.codigo : null,
        trocoPara: troco, pagamentoOnline: metodo === 'na_entrega' ? null : metodo,
      },
    });
    await client.query('COMMIT');
    pedido = { id: r.orderId, numero: r.numero, total: c.total };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (metodo !== 'na_entrega') {
    try {
      await lv.cobrar(loja, pedido, conta, metodo, pag.cartao, urlAviso(req));
    } catch (err) {
      // Sem cobranca o pedido nao segue: cancela (libera o estoque) e devolve o erro para o cliente tentar de novo.
      await lv.cancelarPedido(loja, pedido.id, `não foi possível gerar o pagamento: ${err.message}`.slice(0, 300), { sistema: true, pagamentoStatus: 'recusado' });
      throw err;
    }
  }
  res.status(201).json(await pedidoPublico(loja, pedido.id, conta.id, baseUrl(req)));
});

router.get('/pedidos', comConta, async (req, res) => {
  const pagina = Math.max(Number(req.query.pagina) || 1, 1);
  const { rows } = await db().query(
    `SELECT o.id, o.numero, o.status, o.tipo, o.pagamento_online, o.pagamento_status, o.criado_em,
            COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega - o.desconto AS total,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS itens,
            COUNT(*) OVER()::int AS total_pedidos
     FROM orders o WHERE o.tenant_id = $1 AND o.origem = 'loja_virtual' AND o.lv_conta_id = $2
     ORDER BY o.criado_em DESC LIMIT 20 OFFSET $3`,
    [req.loja.tenant_id, req.conta.id, (pagina - 1) * 20]
  );
  res.json({
    pagina, total: rows.length ? rows[0].total_pedidos : 0,
    pedidos: rows.map((o) => { const e = etapa(o); return { id: o.id, numero: o.numero, etapa: e, etapa_nome: ETAPAS[e] || e, tipo: o.tipo, itens: o.itens, total: lv.n2(o.total), criado_em: o.criado_em }; }),
  });
});

router.get('/pedidos/:id', comConta, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'pedido não encontrado');
  res.json(await pedidoPublico(req.loja, req.params.id, req.conta.id, baseUrl(req)));
});

// Nova tentativa de pagamento (Pix expirado/cartao recusado), enquanto o pedido nao foi preparado nem cancelado.
router.post('/pedidos/:id/pagamento', comConta, limitar('lv-pagamento', 20, 10 * 60 * 1000), async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'pedido não encontrado');
  const atual = await pedidoPublico(req.loja, req.params.id, req.conta.id, baseUrl(req));
  if (!atual.pode_pagar) throw new HttpError(409, atual.pagamento.situacao === 'aprovado' ? 'este pedido já está pago' : 'este pedido não aceita mais pagamento');
  const b = req.body || {};
  if (!['pix', 'cartao'].includes(b.metodo)) throw new HttpError(400, 'escolha Pix ou cartão');
  await lv.cobrar(req.loja, { id: atual.id, numero: atual.numero, total: atual.total }, req.conta, b.metodo, b.cartao, urlAviso(req));
  res.json(await pedidoPublico(req.loja, atual.id, req.conta.id, baseUrl(req)));
});

router.post('/pedidos/:id/cancelar', comConta, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'pedido não encontrado');
  const atual = await pedidoPublico(req.loja, req.params.id, req.conta.id, baseUrl(req));
  if (!atual.pode_cancelar) throw new HttpError(409, 'o pedido já está sendo preparado: fale com a loja para cancelar');
  const motivo = texto((req.body || {}).motivo, 200) || 'cancelado pelo cliente no site';
  await lv.cancelarPedido(req.loja, atual.id, `Cliente: ${motivo}`, { cliente: true });
  res.json(await pedidoPublico(req.loja, atual.id, req.conta.id, baseUrl(req)));
});

module.exports = router;
