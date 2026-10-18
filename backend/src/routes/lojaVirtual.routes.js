// Gerenciamento da loja virtual dentro do sistema (modulo "loja_virtual", area LojaVirtual).
// O site da loja e outro projeto e le tudo isto pela API publica (/api/loja/v1) com a chave gerada aqui.
const express = require('express');
const pool = require('../db/pool');
const { requireArea, requireModulo } = require('../middleware/permissions');
const { HttpError } = require('../utils/http');
const { getOwned, isUuid } = require('../utils/tenant');
const { logAudit } = require('../utils/audit');
const lv = require('../services/lojaVirtual');
const mp = require('../integracoes/mercadopago');
const QRCode = require('qrcode');

const router = express.Router();
router.use('/loja-virtual', requireModulo('loja_virtual'), requireArea('LojaVirtual'));

const texto = (v, max = 120) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const n2 = lv.n2;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const dataOuNula = (v, nome) => {
  if (v === undefined || v === null || v === '') return null;
  if (!DATA_RE.test(String(v))) throw new HttpError(400, `${nome}: data inválida`);
  return String(v);
};
const valorOuNulo = (v, nome, { min = 0 } = {}) => {
  if (v === undefined || v === null || v === '') return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x < min) throw new HttpError(400, `${nome} inválido`);
  return n2(x);
};
const baseUrl = (req) => (process.env.URL_PUBLICA || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

const lojaDaEmpresa = lv.lojaDaEmpresa;

// Configuracao para a tela (sem segredos).
async function configTela(l, base) {
  return {
    ...lv.enderecosDaLoja(l, await lv.dominiosDaLoja(pool, l.id), base),
    url_previa: l.subdominio ? `${base}/loja-previa/${l.subdominio}/` : null,
    tipo: lv.tipoValido(l.tipo),
    modelos: lv.MODELOS[lv.tipoValido(l.tipo)],
    tema: lv.temaEfetivo(l.tema, l.tipo),
    id: l.id, location_id: l.location_id, publicada: l.publicada, pausada: l.pausada, nome: l.nome, descricao: l.descricao,
    logo_id: l.logo_id, logo_url: l.logo_id ? lv.urlImagem(base, l.logo_id) : null,
    banners: (l.banners || []).map((b) => ({ ...b, url: lv.urlImagem(base, b.imagem_id) })),
    telefone: l.telefone, whatsapp: l.whatsapp, email: l.email, endereco: l.endereco, instagram: l.instagram, aviso: l.aviso,
    horarios: l.horarios || {}, aceita_retirada: l.aceita_retirada, aceita_entrega: l.aceita_entrega,
    pedido_minimo: n2(l.pedido_minimo), tempo_preparo_min: l.tempo_preparo_min, tempo_entrega_min: l.tempo_entrega_min,
    taxa_outros_bairros: l.taxa_outros_bairros === null ? null : n2(l.taxa_outros_bairros),
    pagamentos: l.pagamentos || {}, parcelas_max: l.parcelas_max, pix_expira_min: l.pix_expira_min,
    chave: l.api_chave_prefixo ? { prefixo: l.api_chave_prefixo, criada_em: l.api_chave_criada_em } : null,
    mercadopago: l.mp_access_token_cript ? { conectado: true, conta: l.mp_conta, public_key: l.mp_public_key, webhook_secret: !!l.mp_webhook_secret_cript, conectado_em: l.mp_conectado_em } : { conectado: false },
    url_api: `${base}/api/loja/v1`,
    url_webhook_mp: `${base}/api/webhooks/mercadopago/${l.id}`,
  };
}

async function imagemDaEmpresa(db, tenantId, id) {
  if (!isUuid(id)) throw new HttpError(400, 'imagem inválida');
  const r = await db.query(`SELECT id FROM lv_imagens WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (r.rows.length === 0) throw new HttpError(400, 'imagem não encontrada');
  return id;
}

// ---------- configuracao ----------
router.get('/loja-virtual', async (req, res) => {
  const t = req.user.tenantId;
  const l = await lojaDaEmpresa(pool, t);
  const resumo = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM lv_produtos lp JOIN products p ON p.id = lp.product_id WHERE lp.tenant_id = $1 AND lp.publicado AND p.ativo) AS produtos_publicados,
            (SELECT COUNT(*)::int FROM lv_contas WHERE tenant_id = $1 AND ativo) AS clientes,
            (SELECT COUNT(*)::int FROM orders WHERE tenant_id = $1 AND origem = 'loja_virtual' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND status <> 'cancelado') AS pedidos_hoje,
            (SELECT COALESCE(SUM((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id) + o.taxa_entrega - o.desconto), 0)
               FROM orders o WHERE o.tenant_id = $1 AND o.origem = 'loja_virtual' AND o.status <> 'cancelado'
                 AND (o.criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date) AS vendido_mes,
            (SELECT COUNT(*)::int FROM lv_regioes WHERE tenant_id = $1 AND ativo) AS bairros`,
    [t]
  )).rows[0];
  const locais = (await pool.query(`SELECT id, nome, usa_pedidos FROM locations WHERE tenant_id = $1 AND ativo ORDER BY nome`, [t])).rows;
  const situacao = lv.recebendoPedidos(l);
  // O que falta para a loja funcionar (lista de passos na tela).
  const pendencias = [];
  if (!l.location_id) pendencias.push('escolha o estabelecimento de onde sai o estoque');
  else if (!(locais.find((x) => x.id === l.location_id) || {}).usa_pedidos) pendencias.push('ative "usa pedidos" no estabelecimento da loja (Lojas & PDVs)');
  if (!l.subdominio && (await lv.dominiosDaLoja(pool, l.id)).length === 0) pendencias.push('peça ao suporte para definir o endereço (domínio) da loja');
  if (Number(resumo.produtos_publicados) === 0) pendencias.push('publique produtos no site');
  if (l.aceita_entrega && Number(resumo.bairros) === 0 && l.taxa_outros_bairros === null) pendencias.push('cadastre os bairros de entrega (ou uma taxa para qualquer bairro)');
  const pag = l.pagamentos || {};
  if ((pag.pix_online || pag.cartao_online) && !l.mp_access_token_cript) pendencias.push('conecte a conta do Mercado Pago para receber Pix/cartão pelo site');
  if (!pag.pix_online && !pag.cartao_online && !(pag.na_entrega || []).length) pendencias.push('escolha ao menos uma forma de pagamento');
  res.json({ config: await configTela(l, baseUrl(req)), resumo: { ...resumo, vendido_mes: n2(resumo.vendido_mes) }, situacao, pendencias, locais });
});

router.put('/loja-virtual', async (req, res) => {
  const t = req.user.tenantId;
  const atual = await lojaDaEmpresa(pool, t);
  const b = req.body || {};
  const v = (k, f) => (b[k] === undefined ? atual[k] : f(b[k]));
  let locationId = atual.location_id;
  if (b.location_id !== undefined) {
    if (b.location_id === null || b.location_id === '') locationId = null;
    else {
      const loc = await getOwned(pool, 'locations', b.location_id, t, { columns: 'id, ativo, usa_pedidos' });
      if (!loc.ativo) throw new HttpError(400, 'estabelecimento inativo');
      if (!loc.usa_pedidos) throw new HttpError(400, 'este estabelecimento não usa pedidos: ative "usa pedidos" em Lojas & PDVs');
      locationId = loc.id;
    }
  }
  const pagamentos = b.pagamentos === undefined ? atual.pagamentos : (() => {
    const p = b.pagamentos || {};
    const na = Array.isArray(p.na_entrega) ? [...new Set(p.na_entrega)] : [];
    if (na.some((f) => !['dinheiro', 'pix', 'cartao'].includes(f))) throw new HttpError(400, 'forma de pagamento na entrega inválida');
    return { pix_online: !!p.pix_online, cartao_online: !!p.cartao_online, na_entrega: na };
  })();
  const inteiro = (nome, min, max) => (x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${nome}: use um número inteiro de ${min} a ${max}`);
    return n;
  };
  let banners = atual.banners;
  if (b.banners !== undefined) {
    if (!Array.isArray(b.banners) || b.banners.length > 8) throw new HttpError(400, 'banners inválidos (até 8)');
    banners = [];
    for (const x of b.banners) banners.push({ imagem_id: await imagemDaEmpresa(pool, t, x && x.imagem_id), titulo: texto(x.titulo, 80), link: texto(x.link, 300) });
  }
  const logoId = b.logo_id === undefined ? atual.logo_id : b.logo_id ? await imagemDaEmpresa(pool, t, b.logo_id) : null;
  const dados = {
    location_id: locationId,
    publicada: v('publicada', (x) => !!x),
    pausada: v('pausada', (x) => !!x),
    nome: v('nome', (x) => texto(x, 80)),
    descricao: v('descricao', (x) => texto(x, 600)),
    telefone: v('telefone', (x) => texto(x, 30)),
    whatsapp: v('whatsapp', (x) => texto(x, 30)),
    email: v('email', (x) => texto(x, 120)),
    endereco: v('endereco', (x) => texto(x, 200)),
    instagram: v('instagram', (x) => texto(x, 80)),
    aviso: v('aviso', (x) => texto(x, 200)),
    horarios: JSON.stringify(b.horarios === undefined ? atual.horarios : lv.normalizarHorarios(b.horarios)),
    aceita_retirada: v('aceita_retirada', (x) => !!x),
    aceita_entrega: v('aceita_entrega', (x) => !!x),
    pedido_minimo: v('pedido_minimo', (x) => valorOuNulo(x, 'pedido mínimo') || 0),
    tempo_preparo_min: v('tempo_preparo_min', inteiro('tempo de preparo', 0, 600)),
    tempo_entrega_min: v('tempo_entrega_min', inteiro('tempo de entrega', 0, 600)),
    taxa_outros_bairros: b.taxa_outros_bairros === undefined ? atual.taxa_outros_bairros : valorOuNulo(b.taxa_outros_bairros, 'taxa para outros bairros'),
    pagamentos: JSON.stringify(pagamentos),
    parcelas_max: v('parcelas_max', inteiro('parcelas', 1, 12)),
    pix_expira_min: v('pix_expira_min', inteiro('prazo do Pix (minutos)', 5, 1440)),
    banners: JSON.stringify(banners), logo_id: logoId,
    tema: JSON.stringify(b.tema === undefined ? lv.temaEfetivo(atual.tema, atual.tipo) : lv.normalizarTema(b.tema, atual.tema, atual.tipo)),
  };
  if (!dados.aceita_retirada && !dados.aceita_entrega) throw new HttpError(400, 'aceite ao menos retirada ou entrega');
  if (dados.publicada && !dados.location_id) throw new HttpError(400, 'para publicar, escolha o estabelecimento de onde sai o estoque');
  const cols = Object.keys(dados);
  const { rows } = await pool.query(
    `UPDATE lv_lojas SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, atualizado_em = now() WHERE id = $1 RETURNING *`,
    [atual.id, ...cols.map((c) => dados[c])]
  );
  await logAudit(pool, {
    tenantId: t, usuarioId: req.user.id, acao: 'loja_virtual_config', recurso: 'lv_lojas', recursoId: atual.id,
    detalhes: { publicada: dados.publicada, pausada: dados.pausada, location_id: dados.location_id },
  });
  res.json(await configTela(rows[0], baseUrl(req)));
});

// QR code de um link da loja (para imprimir no balcao, na embalagem, no cardapio de mesa).
router.get('/loja-virtual/qrcode', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\/[^\s]{4,300}$/.test(url)) throw new HttpError(400, 'link inválido');
  res.json({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 480 }) });
});

// Nova chave da API (mostrada uma unica vez). A anterior para de funcionar na hora.
router.post('/loja-virtual/chave', async (req, res) => {
  const l = await lojaDaEmpresa(pool, req.user.tenantId);
  const k = lv.gerarChave();
  await pool.query(`UPDATE lv_lojas SET api_chave_hash = $2, api_chave_prefixo = $3, api_chave_criada_em = now(), atualizado_em = now() WHERE id = $1`, [l.id, k.hash, k.prefixo]);
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'loja_virtual_chave', recurso: 'lv_lojas', recursoId: l.id, detalhes: { prefixo: k.prefixo, substituiu: l.api_chave_prefixo || null } });
  res.status(201).json({ chave: k.chave, prefixo: k.prefixo });
});

// Mercado Pago: confere o access token na API antes de guardar (cifrado).
router.put('/loja-virtual/mercadopago', async (req, res) => {
  const l = await lojaDaEmpresa(pool, req.user.tenantId);
  const b = req.body || {};
  const token = texto(b.access_token, 300);
  const publicKey = texto(b.public_key, 200);
  if (!/^(APP_USR|TEST)-/.test(token)) throw new HttpError(400, 'access token inválido: copie o "Access Token" das credenciais do Mercado Pago (começa com APP_USR- ou TEST-)');
  if (!/^(APP_USR|TEST)-/.test(publicKey)) throw new HttpError(400, 'public key inválida: copie a "Public Key" das mesmas credenciais');
  if (token.slice(0, 4) !== publicKey.slice(0, 4)) throw new HttpError(400, 'access token e public key precisam ser do mesmo tipo (as duas de produção ou as duas de teste)');
  let conta;
  try {
    conta = await mp.conta(token);
  } catch (err) {
    throw new HttpError(422, err.status === 401 || err.status === 403 ? 'o Mercado Pago recusou o access token: confira se copiou certo' : err.message);
  }
  const segredo = b.webhook_secret === undefined ? undefined : texto(b.webhook_secret, 200);
  const cript = lv.guardarCredenciaisMp({ access_token: token, webhook_secret: segredo });
  await pool.query(
    `UPDATE lv_lojas SET mp_access_token_cript = $2, mp_public_key = $3, mp_webhook_secret_cript = CASE WHEN $4 THEN $5 ELSE mp_webhook_secret_cript END,
            mp_conta = $6, mp_conectado_em = now(), atualizado_em = now() WHERE id = $1`,
    [l.id, cript.mp_access_token_cript, publicKey, segredo !== undefined, cript.mp_webhook_secret_cript, [conta.nickname, conta.email].filter(Boolean).join(' · ') || String(conta.id)]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'loja_virtual_mercadopago', recurso: 'lv_lojas', recursoId: l.id, detalhes: { conta: conta.id, teste: token.startsWith('TEST-') } });
  res.json(await configTela((await pool.query(`SELECT * FROM lv_lojas WHERE id = $1`, [l.id])).rows[0], baseUrl(req)));
});

router.delete('/loja-virtual/mercadopago', async (req, res) => {
  const l = await lojaDaEmpresa(pool, req.user.tenantId);
  const p = l.pagamentos || {};
  await pool.query(
    `UPDATE lv_lojas SET mp_access_token_cript = NULL, mp_public_key = NULL, mp_webhook_secret_cript = NULL, mp_conta = NULL, mp_conectado_em = NULL,
            pagamentos = $2, atualizado_em = now() WHERE id = $1`,
    [l.id, JSON.stringify({ ...p, pix_online: false, cartao_online: false })]
  );
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: 'loja_virtual_mercadopago_desconectar', recurso: 'lv_lojas', recursoId: l.id });
  res.status(204).end();
});

// ---------- imagens ----------
// Corpo binario (image/jpeg, image/png ou image/webp), ate 2 MB. A tela reduz a foto antes de enviar.
function tipoDaImagem(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

router.post('/loja-virtual/imagens', async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) throw new HttpError(400, 'envie a imagem (JPG, PNG ou WebP)');
  if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, 'imagem grande demais (máximo 2 MB)');
  const mime = tipoDaImagem(buf);
  if (!mime) throw new HttpError(400, 'formato não suportado: use JPG, PNG ou WebP');
  const { rows } = await pool.query(
    `INSERT INTO lv_imagens (tenant_id, mime, dados, tamanho) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.user.tenantId, mime, buf, buf.length]
  );
  res.status(201).json({ id: rows[0].id, url: lv.urlImagem(baseUrl(req), rows[0].id) });
});

// ---------- produtos no site ----------
router.get('/loja-virtual/produtos', async (req, res) => {
  const t = req.user.tenantId;
  const l = await lojaDaEmpresa(pool, t);
  const q = req.query;
  const params = [t];
  let where = 'p.tenant_id = $1 AND p.ativo';
  if (q.busca) {
    params.push(`%${texto(q.busca, 60)}%`);
    where += ` AND (p.nome ILIKE $${params.length} OR p.codigo_interno ILIKE $${params.length} OR p.barcode ILIKE $${params.length} OR lp.nome_site ILIKE $${params.length})`;
  }
  if (q.categoria_id && isUuid(q.categoria_id)) {
    params.push(q.categoria_id);
    where += ` AND (p.categoria_id = $${params.length} OR p.categoria_id IN (SELECT id FROM categories WHERE parent_id = $${params.length}))`;
  }
  if (q.situacao === 'publicados') where += ' AND lp.publicado';
  if (q.situacao === 'nao_publicados') where += ' AND (lp.product_id IS NULL OR NOT lp.publicado)';
  if (q.situacao === 'promocao') where += ' AND lp.preco_promocional IS NOT NULL';
  if (q.situacao === 'sem_foto') where += " AND lp.publicado AND cardinality(lp.imagens) = 0";
  const limite = Math.min(Number(q.limit) || 50, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const base = `FROM products p LEFT JOIN lv_produtos lp ON lp.product_id = p.id LEFT JOIN categories c ON c.id = p.categoria_id WHERE ${where}`;
  const total = Number((await pool.query(`SELECT COUNT(*) AS n ${base}`, params)).rows[0].n);
  const { rows } = await pool.query(
    `SELECT p.id, p.codigo_interno, p.nome, p.unidade, p.preco_venda, c.nome AS categoria_nome,
            COALESCE(lp.publicado, false) AS publicado, lp.nome_site, COALESCE(lp.descricao, '') AS descricao, COALESCE(lp.imagens, '{}') AS imagens,
            lp.preco_promocional, lp.promo_inicio::text, lp.promo_fim::text, COALESCE(lp.destaque, false) AS destaque, COALESCE(lp.ordem, 0) AS ordem
     ${base} ORDER BY COALESCE(lp.publicado, false) DESC, p.nome, p.id LIMIT ${limite} OFFSET ${offset}`,
    params
  );
  const disp = l.location_id ? await (async () => {
    const svc = require('../services/consumo');
    const { reservadosDaLoja } = require('../utils/reservas');
    const reservados = await reservadosDaLoja(pool, t, l.location_id);
    return (await svc.unidadesDisponiveis(pool, t, l.location_id, rows.map((r) => r.id), [], reservados)).produtos;
  })() : new Map();
  const b = baseUrl(req);
  const hoje = lv.agoraSP().data;
  res.json({
    total,
    itens: rows.map((r) => {
      const d = disp.get(r.id);
      return {
        ...r, preco_venda: n2(r.preco_venda), preco_promocional: r.preco_promocional === null ? null : n2(r.preco_promocional),
        imagens: (r.imagens || []).map((id) => ({ id, url: lv.urlImagem(b, id) })),
        preco_site: lv.precoDoProduto(r, hoje),
        disponivel: l.location_id ? (d ? d.unidades : 0) : null,
      };
    }),
  });
});

async function salvarProdutoSite(client, t, productId, b) {
  await getOwned(client, 'products', productId, t, { columns: 'id' });
  const atual = (await client.query(`SELECT *, promo_inicio::text AS promo_inicio, promo_fim::text AS promo_fim FROM lv_produtos WHERE product_id = $1`, [productId])).rows[0] || {};
  const v = (k, f, padrao) => (b[k] === undefined ? (atual[k] === undefined ? padrao : atual[k]) : f(b[k]));
  let imagens = atual.imagens || [];
  if (b.imagens !== undefined) {
    if (!Array.isArray(b.imagens) || b.imagens.length > 8) throw new HttpError(400, 'fotos inválidas (até 8 por produto)');
    imagens = [];
    for (const id of b.imagens) imagens.push(await imagemDaEmpresa(client, t, id));
  }
  const promo = b.preco_promocional === undefined ? (atual.preco_promocional ?? null) : valorOuNulo(b.preco_promocional, 'preço promocional', { min: 0.01 });
  const ini = b.promo_inicio === undefined ? atual.promo_inicio || null : dataOuNula(b.promo_inicio, 'início da promoção');
  const fim = b.promo_fim === undefined ? atual.promo_fim || null : dataOuNula(b.promo_fim, 'fim da promoção');
  if (ini && fim && fim < ini) throw new HttpError(400, 'o fim da promoção é antes do início');
  if (promo !== null) {
    const p = (await client.query(`SELECT preco_venda FROM products WHERE id = $1`, [productId])).rows[0];
    if (promo >= Number(p.preco_venda)) throw new HttpError(400, 'o preço promocional precisa ser menor que o preço de venda');
  }
  const nomeSite = b.nome_site === undefined ? (atual.nome_site ?? null) : texto(b.nome_site, 120) || null;
  if (nomeSite !== null && nomeSite.length < 3) throw new HttpError(400, 'nome no site muito curto');
  const { rows } = await client.query(
    `INSERT INTO lv_produtos (product_id, tenant_id, publicado, nome_site, descricao, imagens, preco_promocional, promo_inicio, promo_fim, destaque, ordem, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (product_id) DO UPDATE SET publicado = $3, nome_site = $4, descricao = $5, imagens = $6, preco_promocional = $7, promo_inicio = $8, promo_fim = $9,
       destaque = $10, ordem = $11, atualizado_em = now()
     RETURNING *, promo_inicio::text AS promo_inicio, promo_fim::text AS promo_fim`,
    [productId, t, v('publicado', (x) => !!x, true), nomeSite, v('descricao', (x) => texto(x, 2000), ''), imagens, promo, promo === null ? null : ini, promo === null ? null : fim,
      v('destaque', (x) => !!x, false), v('ordem', (x) => { const n = Number(x); if (!Number.isInteger(n)) throw new HttpError(400, 'ordem inválida'); return n; }, 0)]
  );
  return rows[0];
}

router.put('/loja-virtual/produtos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await salvarProdutoSite(client, req.user.tenantId, req.params.id, req.body || {});
    await client.query('COMMIT');
    res.json({ ...r, imagens: r.imagens.map((id) => ({ id, url: lv.urlImagem(baseUrl(req), id) })) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Publicar/tirar do site varios de uma vez.
router.post('/loja-virtual/produtos/publicar', async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 500 || b.ids.some((x) => !isUuid(x))) throw new HttpError(400, 'selecione os produtos');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of b.ids) await salvarProdutoSite(client, req.user.tenantId, id, { publicado: !!b.publicado });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: b.publicado ? 'loja_virtual_publicar' : 'loja_virtual_despublicar', recurso: 'lv_produtos', detalhes: { produtos: b.ids.length } });
  res.json({ alterados: b.ids.length });
});

// ---------- categorias no site (foto, ordem, ocultar) ----------
router.get('/loja-virtual/categorias', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.parent_id, p.nome AS pai_nome, lc.imagem_id, COALESCE(lc.ordem, 0) AS ordem, COALESCE(lc.oculta, false) AS oculta,
            (SELECT COUNT(*)::int FROM products pr JOIN lv_produtos lp ON lp.product_id = pr.id
             WHERE pr.ativo AND lp.publicado AND (pr.categoria_id = c.id OR pr.categoria_id IN (SELECT id FROM categories WHERE parent_id = c.id))) AS produtos_no_site
     FROM categories c LEFT JOIN categories p ON p.id = c.parent_id LEFT JOIN lv_categorias lc ON lc.category_id = c.id
     WHERE c.tenant_id = $1 ORDER BY COALESCE(lc.ordem, 0), COALESCE(p.nome, c.nome), c.parent_id NULLS FIRST, c.nome`,
    [req.user.tenantId]
  );
  const b = baseUrl(req);
  res.json(rows.map((r) => ({ ...r, imagem_url: r.imagem_id ? lv.urlImagem(b, r.imagem_id) : null })));
});

router.put('/loja-virtual/categorias/:id', async (req, res) => {
  const t = req.user.tenantId;
  const cat = await getOwned(pool, 'categories', req.params.id, t, { columns: 'id' });
  const b = req.body || {};
  const atual = (await pool.query(`SELECT * FROM lv_categorias WHERE category_id = $1`, [cat.id])).rows[0] || {};
  const imagem = b.imagem_id === undefined ? atual.imagem_id || null : b.imagem_id ? await imagemDaEmpresa(pool, t, b.imagem_id) : null;
  const ordem = b.ordem === undefined ? atual.ordem || 0 : Number(b.ordem);
  if (!Number.isInteger(ordem)) throw new HttpError(400, 'ordem inválida');
  const oculta = b.oculta === undefined ? !!atual.oculta : !!b.oculta;
  await pool.query(
    `INSERT INTO lv_categorias (category_id, tenant_id, imagem_id, ordem, oculta) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (category_id) DO UPDATE SET imagem_id = $3, ordem = $4, oculta = $5, atualizado_em = now()`,
    [cat.id, t, imagem, ordem, oculta]
  );
  res.json({ id: cat.id, imagem_id: imagem, ordem, oculta });
});

// Nova ordem das categorias (lista de ids na ordem desejada).
router.put('/loja-virtual/categorias-ordem', async (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((x) => !isUuid(x))) throw new HttpError(400, 'lista de categorias inválida');
  const ok = (await pool.query(`SELECT id FROM categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tenantId, ids])).rows.map((r) => r.id);
  for (const [i, id] of ids.entries()) {
    if (!ok.includes(id)) continue;
    await pool.query(
      `INSERT INTO lv_categorias (category_id, tenant_id, ordem) VALUES ($1, $2, $3) ON CONFLICT (category_id) DO UPDATE SET ordem = $3, atualizado_em = now()`,
      [id, req.user.tenantId, i + 1]
    );
  }
  res.json({ ordenadas: ok.length });
});

// ---------- bairros de entrega ----------
router.get('/loja-virtual/regioes', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM lv_regioes WHERE tenant_id = $1 ORDER BY ativo DESC, nome`, [req.user.tenantId]);
  res.json(rows.map((r) => ({ ...r, taxa: n2(r.taxa), pedido_minimo: r.pedido_minimo === null ? null : n2(r.pedido_minimo) })));
});

function dadosRegiao(b, atual = {}) {
  const nome = b.nome === undefined ? atual.nome : texto(b.nome, 80);
  if (!nome || nome.length < 2) throw new HttpError(400, 'informe o nome do bairro');
  const taxa = b.taxa === undefined ? Number(atual.taxa || 0) : valorOuNulo(b.taxa, 'taxa');
  const extra = b.tempo_extra_min === undefined ? atual.tempo_extra_min || 0 : Number(b.tempo_extra_min);
  if (!Number.isInteger(extra) || extra < 0 || extra > 600) throw new HttpError(400, 'tempo extra inválido');
  return {
    nome, taxa: taxa || 0, tempo_extra_min: extra,
    pedido_minimo: b.pedido_minimo === undefined ? atual.pedido_minimo ?? null : valorOuNulo(b.pedido_minimo, 'pedido mínimo'),
    ativo: b.ativo === undefined ? atual.ativo !== false : !!b.ativo,
  };
}

router.post('/loja-virtual/regioes', async (req, res) => {
  const b = req.body || {};
  // Varios bairros de uma vez: { nomes: "Centro\nJardim...", taxa }
  const nomes = Array.isArray(b.nomes) ? b.nomes : typeof b.nomes === 'string' ? b.nomes.split(/[\n;]+/) : [b.nome];
  const lista = nomes.map((x) => texto(x, 80)).filter(Boolean);
  if (lista.length === 0) throw new HttpError(400, 'informe o nome do bairro');
  if (lista.length > 200) throw new HttpError(400, 'no máximo 200 bairros por vez');
  const criados = [];
  for (const nome of lista) {
    const d = dadosRegiao({ ...b, nome });
    try {
      const { rows } = await pool.query(
        `INSERT INTO lv_regioes (tenant_id, nome, taxa, tempo_extra_min, pedido_minimo, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.user.tenantId, d.nome, d.taxa, d.tempo_extra_min, d.pedido_minimo, d.ativo]
      );
      criados.push(rows[0]);
    } catch (err) {
      if (err.code === '23505') { if (lista.length === 1) throw new HttpError(409, `o bairro "${d.nome}" já está cadastrado`); continue; }
      throw err;
    }
  }
  res.status(201).json({ criados: criados.length, regioes: criados });
});

router.put('/loja-virtual/regioes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'bairro não encontrado');
  const atual = (await pool.query(`SELECT * FROM lv_regioes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!atual) throw new HttpError(404, 'bairro não encontrado');
  const d = dadosRegiao(req.body || {}, atual);
  try {
    const { rows } = await pool.query(
      `UPDATE lv_regioes SET nome = $2, taxa = $3, tempo_extra_min = $4, pedido_minimo = $5, ativo = $6 WHERE id = $1 RETURNING *`,
      [atual.id, d.nome, d.taxa, d.tempo_extra_min, d.pedido_minimo, d.ativo]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `o bairro "${d.nome}" já está cadastrado`);
    throw err;
  }
});

router.delete('/loja-virtual/regioes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'bairro não encontrado');
  await pool.query(`DELETE FROM lv_regioes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  res.status(204).end();
});

// ---------- cupons ----------
router.get('/loja-virtual/cupons', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, c.inicio::text AS inicio, c.fim::text AS fim,
            (SELECT COUNT(*)::int FROM orders o WHERE o.cupom_id = c.id AND o.status <> 'cancelado') AS usos,
            (SELECT COALESCE(SUM(o.desconto), 0) FROM orders o WHERE o.cupom_id = c.id AND o.status <> 'cancelado') AS desconto_total
     FROM lv_cupons c WHERE c.tenant_id = $1 ORDER BY c.ativo DESC, c.criado_em DESC`,
    [req.user.tenantId]
  );
  res.json(rows.map((c) => ({ ...c, valor: n2(c.valor), pedido_minimo: n2(c.pedido_minimo), desconto_total: n2(c.desconto_total), desconto_maximo: c.desconto_maximo === null ? null : n2(c.desconto_maximo) })));
});

function dadosCupom(b, atual = {}) {
  const v = (k, f, padrao) => (b[k] === undefined ? (atual[k] === undefined ? padrao : atual[k]) : f(b[k]));
  const codigo = v('codigo', (x) => texto(x, 30).toUpperCase(), '');
  if (!/^[A-Z0-9_-]{3,30}$/.test(codigo)) throw new HttpError(400, 'código do cupom: 3 a 30 letras, números, - ou _ (sem espaço)');
  const tipo = v('tipo', String, 'percentual');
  if (!['percentual', 'valor', 'frete_gratis'].includes(tipo)) throw new HttpError(400, 'tipo de cupom inválido');
  const valor = tipo === 'frete_gratis' ? 0 : v('valor', (x) => valorOuNulo(x, 'valor do cupom', { min: 0.01 }), 0);
  if (tipo !== 'frete_gratis' && !(valor > 0)) throw new HttpError(400, 'informe o valor do desconto');
  if (tipo === 'percentual' && valor > 100) throw new HttpError(400, 'o percentual vai até 100');
  const inicio = v('inicio', (x) => dataOuNula(x, 'início'), null);
  const fim = v('fim', (x) => dataOuNula(x, 'fim'), null);
  if (inicio && fim && fim < inicio) throw new HttpError(400, 'o fim é antes do início');
  const inteiroOuNulo = (nome) => (x) => {
    if (x === null || x === '' || x === undefined) return null;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${nome}: número inteiro a partir de 1 (ou vazio = sem limite)`);
    return n;
  };
  return {
    codigo, tipo, valor, inicio, fim,
    descricao: v('descricao', (x) => texto(x, 200), ''),
    desconto_maximo: tipo === 'percentual' ? v('desconto_maximo', (x) => valorOuNulo(x, 'desconto máximo', { min: 0.01 }), null) : null,
    pedido_minimo: v('pedido_minimo', (x) => valorOuNulo(x, 'pedido mínimo') || 0, 0),
    limite_total: v('limite_total', inteiroOuNulo('limite de usos'), null),
    limite_por_cliente: v('limite_por_cliente', inteiroOuNulo('limite por cliente'), 1),
    primeira_compra: v('primeira_compra', (x) => !!x, false),
    ativo: v('ativo', (x) => !!x, true),
  };
}

async function gravarCupom(req, res, atual) {
  const d = dadosCupom(req.body || {}, atual || {});
  const cols = Object.keys(d);
  try {
    const { rows } = atual
      ? await pool.query(`UPDATE lv_cupons SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`, [atual.id, ...cols.map((c) => d[c])])
      : await pool.query(`INSERT INTO lv_cupons (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((c, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [req.user.tenantId, ...cols.map((c) => d[c])]);
    await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: atual ? 'loja_virtual_cupom_editar' : 'loja_virtual_cupom_criar', recurso: 'lv_cupons', recursoId: rows[0].id, detalhes: { codigo: d.codigo, tipo: d.tipo, valor: d.valor } });
    res.status(atual ? 200 : 201).json({ id: rows[0].id, ...d });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `já existe o cupom ${d.codigo}`);
    throw err;
  }
}

router.post('/loja-virtual/cupons', (req, res) => gravarCupom(req, res, null));
router.put('/loja-virtual/cupons/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'cupom não encontrado');
  const atual = (await pool.query(`SELECT *, inicio::text AS inicio, fim::text AS fim FROM lv_cupons WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId])).rows[0];
  if (!atual) throw new HttpError(404, 'cupom não encontrado');
  return gravarCupom(req, res, atual);
});
// Cupom ja usado nao some (fica no historico dos pedidos): so e desativado.
router.delete('/loja-virtual/cupons/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'cupom não encontrado');
  const usado = (await pool.query(`SELECT 1 FROM orders WHERE cupom_id = $1 LIMIT 1`, [req.params.id])).rows.length > 0;
  if (usado) await pool.query(`UPDATE lv_cupons SET ativo = false WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  else await pool.query(`DELETE FROM lv_cupons WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
  res.json({ removido: !usado, desativado: usado });
});

// ---------- clientes do site ----------
router.get('/loja-virtual/clientes', async (req, res) => {
  const params = [req.user.tenantId];
  let where = `a.tenant_id = $1 AND a.email NOT LIKE '%@excluida.local'`;
  if (req.query.busca) {
    params.push(`%${texto(req.query.busca, 60)}%`);
    where += ` AND (a.nome ILIKE $2 OR a.email ILIKE $2 OR a.telefone ILIKE $2)`;
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.nome, a.email, a.telefone, a.aceita_mensagens, a.ativo, a.criado_em, a.ultimo_login_em, a.customer_id,
            (SELECT COUNT(*)::int FROM orders o WHERE o.lv_conta_id = a.id AND o.status <> 'cancelado') AS pedidos,
            (SELECT COALESCE(SUM((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id) + o.taxa_entrega - o.desconto), 0)
               FROM orders o WHERE o.lv_conta_id = a.id AND o.status <> 'cancelado') AS total_gasto,
            (SELECT MAX(o.criado_em) FROM orders o WHERE o.lv_conta_id = a.id) AS ultimo_pedido
     FROM lv_contas a WHERE ${where} ORDER BY a.criado_em DESC LIMIT 300`,
    params
  );
  res.json(rows.map((r) => ({ ...r, total_gasto: n2(r.total_gasto) })));
});

// Bloquear/desbloquear: bloqueada nao entra nem compra (encerra as sessoes abertas).
router.patch('/loja-virtual/clientes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'cliente não encontrado');
  const ativo = !!(req.body || {}).ativo;
  const { rows } = await pool.query(
    `UPDATE lv_contas SET ativo = $3, sessoes_validas_desde = CASE WHEN $3 THEN sessoes_validas_desde ELSE now() END WHERE id = $1 AND tenant_id = $2 RETURNING id, ativo`,
    [req.params.id, req.user.tenantId, ativo]
  );
  if (rows.length === 0) throw new HttpError(404, 'cliente não encontrado');
  await logAudit(pool, { tenantId: req.user.tenantId, usuarioId: req.user.id, acao: ativo ? 'loja_virtual_cliente_desbloquear' : 'loja_virtual_cliente_bloquear', recurso: 'lv_contas', recursoId: req.params.id });
  res.json(rows[0]);
});

// ---------- pagamentos online ----------
router.get('/loja-virtual/pagamentos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.order_id, o.numero, o.cliente_nome, p.metodo, p.status, p.status_detalhe, p.valor, p.parcelas, p.bandeira, p.final_cartao,
            p.provedor_id, p.criado_em, p.aprovado_em, p.estornado_em, o.status AS pedido_status
     FROM lv_pagamentos p JOIN orders o ON o.id = p.order_id
     WHERE p.tenant_id = $1 ORDER BY p.criado_em DESC LIMIT 200`,
    [req.user.tenantId]
  );
  res.json(rows.map((r) => ({ ...r, valor: n2(r.valor), situacao: lv.SITUACAO_MP[r.status] || r.status })));
});

module.exports = router;
