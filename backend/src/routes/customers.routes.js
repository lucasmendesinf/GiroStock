const express = require('express');
const pool = require('../db/pool');
const { requireArea } = require('../middleware/permissions');
const { logAudit } = require('../utils/audit');
const { getOwned, isUuid } = require('../utils/tenant');
const { HttpError } = require('../utils/http');
const { FUSO } = require('../utils/query');

const router = express.Router();

const apenasDigitos = (v) => String(v || '').replace(/\D/g, '');
// Telefone: so digitos; vazio vira NULL (cliente sem telefone). Aceita 10 ou 11 digitos (com DDD).
function normalizarTelefone(v) {
  const d = apenasDigitos(v);
  if (!d) return null;
  if (d.length < 10 || d.length > 13) throw new HttpError(400, 'telefone inválido: informe o DDD e o número (10 ou 11 dígitos)');
  return d;
}
function normalizarAniversario(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!m) throw new HttpError(400, 'aniversário deve estar no formato dd/mm');
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) throw new HttpError(400, 'aniversário inválido');
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`;
}

// Quem pode consultar clientes durante o atendimento (PDV/Pedidos) ou gerenciar a base (Clientes).
const podeAtender = (req, res, next) => {
  const a = (req.user && req.user.areas) || {};
  if (a.Pedidos || a.Clientes || a.Vendas) return next();
  return res.status(403).json({ erro: 'Seu usuário não tem acesso a clientes' });
};
const gerir = requireArea('Clientes');

const MODELOS = {
  reativacao: 'Oi {nome}! Faz um tempinho que você não pede aqui 🍔 Preparamos um desconto de 10% pra você voltar: use o cupom VOLTEI10. Peça pelo WhatsApp ou venha nos visitar!',
  aniversario: 'Parabéns, {nome}! 🎉 Hoje o seu lanche tem desconto especial de aniversário. Passe aqui ou peça pelo WhatsApp e informe o cupom NIVER.',
  promo: 'Oi {nome}! Hoje tem X-Tudo + refri por R$ 28,00 🔥 Peça pelo WhatsApp até as 22h.',
  pronto: 'Oi {nome}, seu pedido está pronto para retirada! Obrigado pela preferência 😊',
};

// ---------- agregados e segmentos (calculados por consulta sobre os pedidos finalizados) ----------
const SQL_CLIENTES = (filtroLoja) => `
  WITH ped AS (
    SELECT o.customer_id, COUNT(*)::int AS pedidos,
           SUM(COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega) AS total_gasto,
           MIN(o.criado_em) AS primeiro_em, MAX(COALESCE(o.finalizado_em, o.criado_em)) AS ultimo_em
    FROM orders o
    WHERE o.tenant_id = $1 AND o.status = 'finalizado' AND o.customer_id IS NOT NULL ${filtroLoja}
    GROUP BY o.customer_id
  ), fav AS (
    SELECT DISTINCT ON (x.customer_id) x.customer_id, x.produto FROM (
      SELECT o.customer_id, p.nome AS produto, SUM(oi.quantidade) AS q
      FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
      WHERE o.tenant_id = $1 AND o.status = 'finalizado' AND o.customer_id IS NOT NULL ${filtroLoja}
      GROUP BY o.customer_id, p.nome
    ) x ORDER BY x.customer_id, x.q DESC, x.produto
  )
  SELECT c.id, c.nome, c.telefone, c.aniversario, c.observacao, c.aceita_mensagens, c.consentimento_em, c.consentimento_origem, c.ativo, c.criado_em,
         COALESCE(ped.pedidos, 0) AS pedidos, COALESCE(ped.total_gasto, 0) AS total_gasto, ped.primeiro_em, ped.ultimo_em, fav.produto AS produto_favorito,
         (SELECT a.bairro FROM customer_addresses a WHERE a.customer_id = c.id ORDER BY a.padrao DESC, a.endereco LIMIT 1) AS bairro,
         (SELECT a.endereco FROM customer_addresses a WHERE a.customer_id = c.id ORDER BY a.padrao DESC, a.endereco LIMIT 1) AS endereco,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - ped.ultimo_em)) / 86400))::int AS dias_ultimo,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(ped.primeiro_em, c.criado_em))) / 86400))::int AS dias_desde,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - c.criado_em)) / 86400))::int AS dias_cadastro,
         EXTRACT(MONTH FROM (now() AT TIME ZONE '${FUSO}'))::int AS mes_atual
  FROM customers c
  LEFT JOIN ped ON ped.customer_id = c.id
  LEFT JOIN fav ON fav.customer_id = c.id
  WHERE c.tenant_id = $1 AND c.ativo`;

function segmentos(c, vipLimite) {
  const s = [];
  if (c.dias_desde <= 30) s.push('novo');
  if (c.pedidos >= 3) s.push('recorrente');
  if (Number(c.total_gasto) >= vipLimite) s.push('vip');
  if (c.dias_ultimo !== null && c.dias_ultimo >= 30 && c.dias_ultimo < 60) s.push('risco');
  if (c.dias_ultimo !== null && c.dias_ultimo >= 60) s.push('inativo');
  if (c.aniversario && Number(c.aniversario.slice(3, 5)) === c.mes_atual) s.push('aniversario');
  if (!c.telefone) s.push('sem_whatsapp');
  return s;
}

function formatar(c, vipLimite) {
  const pedidos = c.pedidos;
  const total = Number(c.total_gasto);
  return {
    id: c.id, nome: c.nome, telefone: c.telefone, aniversario: c.aniversario, observacao: c.observacao,
    aceita_mensagens: c.aceita_mensagens, consentimento_em: c.consentimento_em, consentimento_origem: c.consentimento_origem,
    bairro: c.bairro || '', endereco: c.endereco || '',
    pedidos, total_gasto: total, ticket_medio: pedidos > 0 ? Number((total / pedidos).toFixed(2)) : 0,
    ultimo_pedido_em: c.ultimo_em, dias_ultimo: c.dias_ultimo, dias_desde: c.dias_desde, dias_cadastro: c.dias_cadastro,
    produto_favorito: c.produto_favorito, criado_em: c.criado_em,
    segmentos: segmentos(c, vipLimite),
  };
}

async function vipLimiteDoTenant(db, tenantId) {
  const { rows } = await db.query(`SELECT clientes_vip_limite FROM tenants WHERE id = $1`, [tenantId]);
  return Number(rows[0].clientes_vip_limite);
}

router.get('/customers/config', gerir, async (req, res) => {
  res.json({ vip_limite: await vipLimiteDoTenant(pool, req.user.tenantId) });
});
router.put('/customers/config', gerir, async (req, res) => {
  const v = Number(req.body && req.body.vip_limite);
  if (!(v >= 0)) throw new HttpError(400, 'limite VIP inválido');
  await pool.query(`UPDATE tenants SET clientes_vip_limite = $1 WHERE id = $2`, [v, req.user.tenantId]);
  res.json({ vip_limite: v });
});

// ---------- lista ----------
router.get('/customers', gerir, async (req, res) => {
  const { q, segmento, location_id } = req.query;
  const params = [req.user.tenantId];
  let filtroLoja = '';
  let existeNaLoja = '';
  if (location_id && isUuid(location_id)) {
    params.push(location_id);
    filtroLoja = ` AND o.location_id = $${params.length}`;
    existeNaLoja = ` AND EXISTS (SELECT 1 FROM orders ox WHERE ox.customer_id = c.id AND ox.location_id = $${params.length} AND ox.status <> 'cancelado')`;
  }
  const { rows } = await pool.query(`${SQL_CLIENTES(filtroLoja)}${existeNaLoja} ORDER BY c.nome`, params);
  const vip = await vipLimiteDoTenant(pool, req.user.tenantId);
  let lista = rows.map((r) => formatar(r, vip));
  if (q) {
    const t = String(q).trim().toLowerCase();
    const digitos = apenasDigitos(q);
    lista = lista.filter((c) => c.nome.toLowerCase().includes(t) || (digitos && (c.telefone || '').includes(digitos)) || c.bairro.toLowerCase().includes(t));
  }
  if (segmento && segmento !== 'todos') lista = lista.filter((c) => c.segmentos.includes(segmento));
  res.json(lista);
});

// ---------- busca para o atendimento (PDV / novo pedido) ----------
async function resumoCurto(db, tenantId, customerId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS pedidos,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MAX(COALESCE(o.finalizado_em, o.criado_em)))) / 86400))::int AS dias_ultimo
     FROM orders o WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.status <> 'cancelado'`,
    [tenantId, customerId]
  );
  return rows[0];
}

router.get('/customers/by-phone/:telefone', podeAtender, async (req, res) => {
  const tel = apenasDigitos(req.params.telefone);
  if (tel.length < 10) return res.json(null);
  const { rows } = await pool.query(
    `SELECT id, nome, telefone, aniversario, aceita_mensagens FROM customers WHERE tenant_id = $1 AND telefone = $2 AND ativo`,
    [req.user.tenantId, tel]
  );
  if (rows.length === 0) return res.json(null);
  const c = rows[0];
  const enderecos = await pool.query(`SELECT id, rotulo, endereco, bairro, padrao FROM customer_addresses WHERE customer_id = $1 ORDER BY padrao DESC, endereco`, [c.id]);
  res.json({ ...c, enderecos: enderecos.rows, ...(await resumoCurto(pool, req.user.tenantId, c.id)) });
});

router.get('/customers/suggest', podeAtender, async (req, res) => {
  const tel = apenasDigitos(req.query.telefone);
  if (tel.length < 4 || tel.length > 9) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, nome, telefone FROM customers WHERE tenant_id = $1 AND ativo AND telefone LIKE $2 ORDER BY nome LIMIT 3`,
    [req.user.tenantId, `%${tel}%`]
  );
  res.json(rows);
});

// ---------- criar / editar ----------
async function inserirCliente(client, tenantId, dados) {
  const telefone = normalizarTelefone(dados.telefone);
  const aceita = !!dados.aceita_mensagens;
  try {
    const { rows } = await client.query(
      `INSERT INTO customers (tenant_id, nome, telefone, aniversario, observacao, aceita_mensagens, consentimento_em, consentimento_origem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tenantId, String(dados.nome || '').trim().slice(0, 120), telefone, normalizarAniversario(dados.aniversario), String(dados.observacao || '').slice(0, 500),
        aceita, aceita ? new Date() : null, aceita ? (dados.consentimento_origem || 'cadastro') : null]
    );
    const id = rows[0].id;
    const endereco = String(dados.endereco || '').trim();
    if (endereco) {
      await client.query(
        `INSERT INTO customer_addresses (customer_id, rotulo, endereco, bairro, padrao) VALUES ($1, $2, $3, $4, true)`,
        [id, String(dados.rotulo || 'Casa').slice(0, 30), endereco.slice(0, 300), String(dados.bairro || '').trim().slice(0, 80)]
      );
    }
    return id;
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Já existe cliente com este telefone');
    throw err;
  }
}

router.post('/customers', gerir, async (req, res) => {
  const b = req.body || {};
  if (String(b.nome || '').trim().length < 2) throw new HttpError(400, 'informe o nome do cliente');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await inserirCliente(client, req.user.tenantId, { ...b, consentimento_origem: b.consentimento_origem || 'cadastro manual' });
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'criar_cliente', recurso: 'customers', recursoId: id, detalhes: { nome: b.nome } });
    await client.query('COMMIT');
    res.status(201).json(await fichaDoCliente(pool, req.user.tenantId, id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.patch('/customers/:id', gerir, async (req, res) => {
  const atual = await getOwned(pool, 'customers', req.params.id, req.user.tenantId, { columns: 'id, nome, telefone, aniversario, observacao, aceita_mensagens, consentimento_em, consentimento_origem' });
  const b = req.body || {};
  const nome = b.nome !== undefined ? String(b.nome).trim() : atual.nome;
  if (nome.length < 2) throw new HttpError(400, 'informe o nome do cliente');
  const telefone = b.telefone !== undefined ? normalizarTelefone(b.telefone) : atual.telefone;
  const aniversario = b.aniversario !== undefined ? normalizarAniversario(b.aniversario) : atual.aniversario;
  const observacao = b.observacao !== undefined ? String(b.observacao).slice(0, 500) : atual.observacao;
  let aceita = atual.aceita_mensagens;
  let consEm = atual.consentimento_em;
  let consOrigem = atual.consentimento_origem;
  if (b.aceita_mensagens !== undefined && !!b.aceita_mensagens !== atual.aceita_mensagens) {
    aceita = !!b.aceita_mensagens;
    consEm = new Date();
    consOrigem = aceita ? String(b.consentimento_origem || 'tela de clientes') : 'retirado na tela de clientes';
  }
  try {
    await pool.query(
      `UPDATE customers SET nome = $1, telefone = $2, aniversario = $3, observacao = $4, aceita_mensagens = $5, consentimento_em = $6, consentimento_origem = $7
       WHERE id = $8 AND tenant_id = $9`,
      [nome.slice(0, 120), telefone, aniversario, observacao, aceita, consEm, consOrigem, req.params.id, req.user.tenantId]
    );
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Já existe cliente com este telefone');
    throw err;
  }
  res.json(await fichaDoCliente(pool, req.user.tenantId, req.params.id));
});

router.post('/customers/:id/addresses', gerir, async (req, res) => {
  await getOwned(pool, 'customers', req.params.id, req.user.tenantId);
  const b = req.body || {};
  const endereco = String(b.endereco || '').trim();
  if (endereco.length < 3) throw new HttpError(400, 'informe o endereço');
  const existe = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_id = $1`, [req.params.id]);
  const padrao = !!b.padrao || existe.rows[0].n === 0;
  if (padrao) await pool.query(`UPDATE customer_addresses SET padrao = false WHERE customer_id = $1`, [req.params.id]);
  await pool.query(
    `INSERT INTO customer_addresses (customer_id, rotulo, endereco, bairro, padrao) VALUES ($1, $2, $3, $4, $5)`,
    [req.params.id, String(b.rotulo || 'Casa').slice(0, 30), endereco.slice(0, 300), String(b.bairro || '').trim().slice(0, 80), padrao]
  );
  res.status(201).json(await fichaDoCliente(pool, req.user.tenantId, req.params.id));
});

// "Excluir" = desativar (os pedidos antigos continuam ligados ao cadastro).
router.delete('/customers/:id', gerir, async (req, res) => {
  await getOwned(pool, 'customers', req.params.id, req.user.tenantId);
  await pool.query(`UPDATE customers SET ativo = false WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  res.status(204).send();
});

// ---------- ficha ----------
async function fichaDoCliente(db, tenantId, id) {
  const { rows } = await db.query(`${SQL_CLIENTES('')} AND c.id = $2`, [tenantId, id]);
  if (rows.length === 0) throw new HttpError(404, 'cliente não encontrado');
  const vip = await vipLimiteDoTenant(db, tenantId);
  const enderecos = await db.query(`SELECT id, rotulo, endereco, bairro, padrao FROM customer_addresses WHERE customer_id = $1 ORDER BY padrao DESC, endereco`, [id]);
  const pedidos = await db.query(
    `SELECT o.id, o.numero, o.status, o.criado_em, o.origem, o.tipo, o.location_id,
            COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega AS total,
            COALESCE((SELECT json_agg(json_build_object('product_id', oi.product_id, 'nome', p.nome, 'quantidade', oi.quantidade, 'observacao', oi.observacao) ORDER BY p.nome)
                      FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id), '[]') AS itens
     FROM orders o WHERE o.tenant_id = $1 AND o.customer_id = $2 AND o.status <> 'cancelado'
     ORDER BY o.criado_em DESC LIMIT 8`,
    [tenantId, id]
  );
  const mensagens = await db.query(
    `SELECT m.id, m.modelo, m.texto, m.status, m.criado_em, u.nome AS enviado_por_nome FROM message_log m LEFT JOIN users u ON u.id = m.enviado_por
     WHERE m.tenant_id = $1 AND m.customer_id = $2 ORDER BY m.criado_em DESC LIMIT 10`,
    [tenantId, id]
  );
  return { ...formatar(rows[0], vip), enderecos: enderecos.rows, ultimos_pedidos: pedidos.rows, mensagens: mensagens.rows };
}


// ---------- "Gerar a partir dos pedidos" ----------
async function candidatosImportacao(db, tenantId) {
  const { rows } = await db.query(
    `SELECT o.cliente_nome, o.cliente_telefone, o.endereco, o.criado_em FROM orders o
     WHERE o.tenant_id = $1 AND o.customer_id IS NULL AND o.status <> 'cancelado' ORDER BY o.criado_em DESC`,
    [tenantId]
  );
  const grupos = new Map(); // telefone ('' = sem telefone) -> dados
  for (const r of rows) {
    const tel = apenasDigitos(r.cliente_telefone);
    const chave = tel.length >= 10 ? tel : '';
    const g = grupos.get(chave) || { telefone: chave || null, nome: '', endereco: '', pedidos: 0 };
    g.pedidos += 1;
    if (!g.nome && r.cliente_nome) g.nome = r.cliente_nome; // mais recente primeiro
    if (!g.endereco && r.endereco) g.endereco = r.endereco;
    grupos.set(chave, g);
  }
  const existentes = await db.query(`SELECT id, nome, telefone FROM customers WHERE tenant_id = $1 AND telefone IS NOT NULL`, [tenantId]);
  const porTel = new Map(existentes.rows.map((c) => [c.telefone, c]));
  const lista = [];
  for (const g of grupos.values()) {
    if (!g.telefone) { lista.push({ ...g, nome: g.nome || 'Balcão', tipo: 'sem_telefone' }); continue; }
    const ex = porTel.get(g.telefone);
    if (!ex) lista.push({ ...g, nome: g.nome || 'Cliente', tipo: 'novo' });
    else if (String(ex.nome).trim().toLowerCase() === String(g.nome).trim().toLowerCase() || !g.nome) lista.push({ ...g, nome: ex.nome, tipo: 'ja_cadastrado', com: ex.nome });
    else lista.push({ ...g, tipo: 'mesclar', com: ex.nome });
  }
  const ordem = { novo: 0, mesclar: 1, ja_cadastrado: 2, sem_telefone: 3 };
  return lista.sort((a, b) => ordem[a.tipo] - ordem[b.tipo] || b.pedidos - a.pedidos);
}

router.get('/customers/import-preview', gerir, async (req, res) => {
  const lista = await candidatosImportacao(pool, req.user.tenantId);
  res.json({ candidatos: lista, novos: lista.filter((c) => c.tipo === 'novo').length, duplicados: lista.filter((c) => c.tipo === 'mesclar').length });
});

router.post('/customers/import', gerir, async (req, res) => {
  const escolhidos = new Set(((req.body && req.body.telefones) || []).map(apenasDigitos));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lista = await candidatosImportacao(client, req.user.tenantId);
    let criados = 0;
    let mesclados = 0;
    for (const c of lista) {
      if (c.tipo === 'sem_telefone') continue;
      let customerId = null;
      if (c.tipo === 'novo' && escolhidos.has(c.telefone)) {
        customerId = await inserirCliente(client, req.user.tenantId, { nome: c.nome, telefone: c.telefone, endereco: c.endereco, aceita_mensagens: false });
        criados += 1;
      } else if (c.tipo === 'mesclar' && escolhidos.has(c.telefone)) {
        const ex = await client.query(`SELECT id FROM customers WHERE tenant_id = $1 AND telefone = $2`, [req.user.tenantId, c.telefone]);
        customerId = ex.rows[0].id;
        mesclados += 1;
      } else if (c.tipo === 'ja_cadastrado') {
        const ex = await client.query(`SELECT id FROM customers WHERE tenant_id = $1 AND telefone = $2`, [req.user.tenantId, c.telefone]);
        customerId = ex.rows[0].id;
      }
      if (customerId) {
        await client.query(
          `UPDATE orders SET customer_id = $1 WHERE tenant_id = $2 AND customer_id IS NULL AND status <> 'cancelado'
             AND regexp_replace(cliente_telefone, '\\D', '', 'g') = $3`,
          [customerId, req.user.tenantId, c.telefone]
        );
      }
    }
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'importar_clientes', recurso: 'customers', detalhes: { criados, mesclados } });
    await client.query('COMMIT');
    res.json({ criados, mesclados });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------- mesclar duplicados ----------
router.post('/customers/:id/merge', gerir, async (req, res) => {
  const paraId = req.body && req.body.para_id;
  if (!isUuid(paraId) || paraId === req.params.id) throw new HttpError(400, 'escolha outro cliente para mesclar');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const origem = await getOwned(client, 'customers', req.params.id, req.user.tenantId, { columns: 'id, nome, telefone, aniversario', lock: true });
    const destino = await getOwned(client, 'customers', paraId, req.user.tenantId, { columns: 'id, telefone, aniversario', lock: true });
    await client.query(`UPDATE orders SET customer_id = $1 WHERE customer_id = $2 AND tenant_id = $3`, [paraId, origem.id, req.user.tenantId]);
    await client.query(`UPDATE message_log SET customer_id = $1 WHERE customer_id = $2 AND tenant_id = $3`, [paraId, origem.id, req.user.tenantId]);
    await client.query(
      `UPDATE customer_addresses a SET customer_id = $1, padrao = false WHERE a.customer_id = $2
         AND NOT EXISTS (SELECT 1 FROM customer_addresses b WHERE b.customer_id = $1 AND lower(b.endereco) = lower(a.endereco))`,
      [paraId, origem.id]
    );
    // O cadastro de destino fica; so completa o que ele nao tem.
    if (!destino.aniversario && origem.aniversario) await client.query(`UPDATE customers SET aniversario = $1 WHERE id = $2`, [origem.aniversario, paraId]);
    await client.query(`UPDATE customers SET ativo = false, telefone = NULL WHERE id = $1`, [origem.id]);
    if (!destino.telefone && origem.telefone) await client.query(`UPDATE customers SET telefone = $1 WHERE id = $2`, [origem.telefone, paraId]);
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'mesclar_clientes', recurso: 'customers', recursoId: paraId, detalhes: { origem: origem.id, nome_origem: origem.nome } });
    await client.query('COMMIT');
    res.json(await fichaDoCliente(pool, req.user.tenantId, paraId));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------- mensagens (fase 2: link wa.me, sem API oficial) ----------
const RODAPE_SAIR = '\n\nResponda SAIR para não receber mais mensagens.';
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || 'cliente';

async function destinatarios(req, { segmento, customer_id }) {
  const vip = await vipLimiteDoTenant(pool, req.user.tenantId);
  const { rows } = await pool.query(`${SQL_CLIENTES('')} ORDER BY c.nome`, [req.user.tenantId]);
  let lista = rows.map((r) => formatar(r, vip));
  if (customer_id) lista = lista.filter((c) => c.id === customer_id);
  else if (segmento && segmento !== 'todos') lista = lista.filter((c) => c.segmentos.includes(segmento));
  const alvo = lista;
  const aptos = alvo.filter((c) => c.aceita_mensagens && c.telefone);
  return { aptos, bloqueados: alvo.length - aptos.length };
}

function montarMensagem(texto, cliente) {
  const base = String(texto || '').replace(/\{nome\}/g, primeiroNome(cliente.nome));
  return base.includes('SAIR') ? base : base + RODAPE_SAIR;
}

router.get('/customers/campaigns/modelos', gerir, (req, res) => {
  res.json(Object.entries(MODELOS).map(([id, texto]) => ({ id, texto, nome: { reativacao: 'Reativação', aniversario: 'Aniversário', promo: 'Promoção do dia', pronto: 'Pedido pronto' }[id] })));
});

router.post('/customers/campaigns/preview', gerir, async (req, res) => {
  const b = req.body || {};
  if (!String(b.texto || '').trim()) throw new HttpError(400, 'escreva a mensagem');
  const { aptos, bloqueados } = await destinatarios(req, b);
  res.json({
    total: aptos.length, bloqueados,
    destinatarios: aptos.map((c) => {
      const mensagem = montarMensagem(b.texto, c);
      return { id: c.id, nome: c.nome, telefone: c.telefone, mensagem, link: `https://wa.me/55${c.telefone.replace(/^55/, '')}?text=${encodeURIComponent(mensagem)}` };
    }),
  });
});

router.post('/customers/campaigns/queue', gerir, async (req, res) => {
  const b = req.body || {};
  if (!String(b.texto || '').trim()) throw new HttpError(400, 'escreva a mensagem');
  const { aptos } = await destinatarios(req, b);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of aptos) {
      await client.query(
        `INSERT INTO message_log (tenant_id, customer_id, segmento, modelo, texto, status, enviado_por) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.tenantId, c.id, b.segmento || null, b.modelo || null, montarMensagem(b.texto, c), b.status === 'aberto' ? 'aberto' : 'fila', req.user.id]
      );
    }
    await logAudit(client, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'fila_mensagens', recurso: 'customers', detalhes: { segmento: b.segmento, modelo: b.modelo, total: aptos.length } });
    await client.query('COMMIT');
    res.status(201).json({ registradas: aptos.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/customers/:id', gerir, async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(400, 'cliente inválido');
  res.json(await fichaDoCliente(pool, req.user.tenantId, req.params.id));
});

module.exports = router;
module.exports.inserirCliente = inserirCliente;
module.exports.apenasDigitos = apenasDigitos;
