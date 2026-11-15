// iFood no GiroStock: conexao da loja, recebimento de pedidos (polling), importacao, vinculo de itens e
// sincronizacao de status. Roda SEMPRE no banco de producao (o modo teste nao recebe pedidos reais).
const api = require('./api');
const { pedidoDoIfood } = require('./mapear');
const { cifrar, decifrar } = require('../../services/totp');
const { dadosDaEmpresa, efetivos } = require('../../utils/limites');
const comum = require('../comum');
const { logAudit } = require('../../utils/audit');
const { HttpError } = require('../../utils/http');
const { ErroPlataforma } = require('../http');
const { reservadosDaLoja } = require('../../utils/reservas');
const { unidadesDisponiveis } = require('../../services/consumo');
const crypto = require('crypto');
const precos = require('../../services/precos');

const { db, integracao, registrarErro, importar, cancelarLocal, pedidoExternoDoPedido, pedidoExterno, vincular } = comum;
const PLATAFORMA = 'ifood';
const MARGEM_RENOVACAO_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- token
async function tokenDa(integ) {
  if (!integ.access_token_cript) throw new HttpError(409, 'iFood não conectado nesta loja');
  const expira = integ.token_expira_em ? new Date(integ.token_expira_em).getTime() : 0;
  if (expira - Date.now() > MARGEM_RENOVACAO_MS) return decifrar(integ.access_token_cript);
  if (!integ.refresh_token_cript) return decifrar(integ.access_token_cript);
  try {
    const t = await api.renovarToken(decifrar(integ.refresh_token_cript));
    await salvarTokens(integ.id, t);
    integ.access_token_cript = cifrar(t.accessToken);
    integ.token_expira_em = new Date(Date.now() + Number(t.expiresIn || 21600) * 1000);
    return t.accessToken;
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      await db().query(`UPDATE integracoes_delivery SET status = 'reautorizar', ultimo_erro = $2, ultimo_erro_em = now(), atualizado_em = now() WHERE id = $1`, [integ.id, 'autorização expirada: conecte o iFood de novo']);
    }
    throw err;
  }
}

async function salvarTokens(id, t) {
  await db().query(
    `UPDATE integracoes_delivery SET access_token_cript = $2, refresh_token_cript = COALESCE($3, refresh_token_cript),
            token_expira_em = now() + ($4 || ' seconds')::interval, atualizado_em = now() WHERE id = $1`,
    [id, cifrar(t.accessToken), t.refreshToken ? cifrar(t.refreshToken) : null, String(Number(t.expiresIn || 21600))]
  );
}

// ---------------------------------------------------------------- conexao da loja
async function iniciarConexao(user, locationId) {
  if (!api.configurado()) throw new HttpError(503, 'integração com o iFood ainda não configurada no servidor (IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET)');
  const loja = await db().query(`SELECT id, nome, ativo FROM locations WHERE id = $1 AND tenant_id = $2`, [locationId, user.tenantId]);
  if (loja.rows.length === 0) throw new HttpError(404, 'loja não encontrada');
  if (!loja.rows[0].ativo) throw new HttpError(400, 'esta loja está inativa');
  const atual = await db().query(`SELECT id, status FROM integracoes_delivery WHERE location_id = $1 AND plataforma = $2`, [locationId, PLATAFORMA]);
  if (atual.rows[0] && atual.rows[0].status === 'conectado') throw new HttpError(409, 'o iFood já está conectado nesta loja');
  const c = await api.gerarCodigoVinculo();
  const valores = [user.tenantId, locationId, c.userCode, cifrar(c.authorizationCodeVerifier), String(Number(c.expiresIn || 600)), user.id];
  const { rows } = atual.rows[0]
    ? await db().query(
      `UPDATE integracoes_delivery SET status = 'aguardando_codigo', codigo_vinculo = $3, verificador_token_cript = $4,
              codigo_vinculo_expira_em = now() + ($5 || ' seconds')::interval, criado_por = $6, ultimo_erro = NULL, atualizado_em = now()
       WHERE id = $7 AND tenant_id = $1::uuid AND location_id = $2::uuid RETURNING id`, [...valores, atual.rows[0].id])
    : await db().query(
      `INSERT INTO integracoes_delivery (tenant_id, location_id, plataforma, status, codigo_vinculo, verificador_token_cript, codigo_vinculo_expira_em, criado_por)
       VALUES ($1, $2, 'ifood', 'aguardando_codigo', $3, $4, now() + ($5 || ' seconds')::interval, $6) RETURNING id`, valores);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_conectar_iniciar', recurso: 'integracoes_delivery', recursoId: rows[0].id, detalhes: { loja: loja.rows[0].nome } });
  return { id: rows[0].id, codigo: c.userCode, link: c.verificationUrlComplete || c.verificationUrl, expira_em_segundos: Number(c.expiresIn || 600) };
}

// A loja autorizou no Portal do Parceiro e colou o codigo de autorizacao: troca por tokens e descobre a loja do iFood.
async function concluirConexao(user, id, codigoAutorizacao) {
  const integ = await integracao(id, user.tenantId);
  if (integ.status !== 'aguardando_codigo') throw new HttpError(409, 'gere um novo código de vínculo para conectar');
  const codigo = String(codigoAutorizacao || '').trim();
  if (codigo.length < 4) throw new HttpError(400, 'cole o código de autorização que o Portal do Parceiro mostrou');
  let t;
  try {
    t = await api.tokenPorCodigo(codigo, decifrar(integ.verificador_token_cript));
  } catch (err) {
    if (err.status >= 400 && err.status < 500) throw new HttpError(400, 'código de autorização inválido ou expirado: gere um novo vínculo e tente de novo');
    throw err;
  }
  await salvarTokens(id, t);
  const lojas = await api.lojas(t.accessToken);
  if (lojas.length === 1) return escolherLoja(user, id, lojas[0].id, lojas);
  await db().query(`UPDATE integracoes_delivery SET status = 'escolher_loja', lojas_disponiveis = $2, codigo_vinculo = NULL, atualizado_em = now() WHERE id = $1`, [id, JSON.stringify(lojas)]);
  return { status: 'escolher_loja', lojas };
}

async function escolherLoja(user, id, merchantId, lojasConhecidas) {
  const integ = await integracao(id, user.tenantId);
  const lojas = lojasConhecidas || integ.lojas_disponiveis || [];
  const m = lojas.find((x) => x.id === merchantId);
  if (!m) throw new HttpError(400, 'escolha uma das lojas da sua conta iFood');
  const dup = await db().query(`SELECT 1 FROM integracoes_delivery WHERE plataforma = 'ifood' AND merchant_id = $1 AND status <> 'desconectado' AND id <> $2`, [merchantId, id]);
  if (dup.rows.length > 0) throw new HttpError(409, 'esta loja do iFood já está conectada a outra loja do GiroStock');
  await db().query(
    `UPDATE integracoes_delivery SET status = 'conectado', merchant_id = $2, merchant_nome = $3, codigo_vinculo = NULL, verificador_token_cript = NULL,
            lojas_disponiveis = NULL, ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`,
    [id, merchantId, m.nome]
  );
  // Pedidos do iFood entram na tela de Pedidos: a loja passa a usar pedidos.
  await db().query(`UPDATE locations SET usa_pedidos = true WHERE id = $1 AND tenant_id = $2`, [integ.location_id, user.tenantId]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_conectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { merchant_id: merchantId, merchant_nome: m.nome } });
  return { status: 'conectado', merchant_id: merchantId, merchant_nome: m.nome };
}

async function desconectar(user, id) {
  const integ = await integracao(id, user.tenantId);
  await db().query(
    `UPDATE integracoes_delivery SET status = 'desconectado', access_token_cript = NULL, refresh_token_cript = NULL, verificador_token_cript = NULL,
            token_expira_em = NULL, codigo_vinculo = NULL, atualizado_em = now() WHERE id = $1`, [id]
  );
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_desconectado', recurso: 'integracoes_delivery', recursoId: id, detalhes: { merchant_id: integ.merchant_id } });
}

// ---------------------------------------------------------------- importacao
// Guarda o pedido como veio e tenta transformar em pedido do GiroStock. Idempotente (mesmo pedido = mesma linha).
async function receberPedido(integ, externoId) {
  const token = await tokenDa(integ);
  const payload = await api.pedido(token, externoId);
  const dados = pedidoDoIfood(payload);
  const novo = await comum.guardarPedido(integ, dados, 'PLACED', payload);
  if (!novo) return null; // ja recebido
  return importar(novo);
}

async function confirmarNoIfood(integ, pe) {
  if (pe.confirmado) return;
  await api.confirmar(await tokenDa(integ), pe.externo_id);
  await db().query(`UPDATE pedidos_externos SET confirmado = true, atualizado_em = now() WHERE id = $1`, [pe.id]);
}

// ---------------------------------------------------------------- eventos
const STATUS_POR_CODIGO = { PLC: 'PLACED', CFM: 'CONFIRMED', SPS: 'SEPARATION_STARTED', SPE: 'SEPARATION_ENDED', RTP: 'READY_TO_PICKUP', DSP: 'DISPATCHED', CON: 'CONCLUDED', CAN: 'CANCELLED' };

async function tratarEvento(integ, ev) {
  // entrega Sob Demanda (entregador do iFood para pedido de outro canal): nao e pedido do iFood
  if (await require('./entregas').tratarEvento(integ, ev)) return;
  const codigo = ev.code || '';
  const cheio = ev.fullCode || STATUS_POR_CODIGO[codigo] || codigo;
  if (codigo === 'PLC' || cheio === 'PLACED') { await receberPedido(integ, ev.orderId); return; }
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE plataforma = 'ifood' AND externo_id = $1`, [ev.orderId])).rows[0];
  if (!pe) {
    // Evento de pedido que ainda nao temos (ex.: chegou antes do PLC): busca o pedido inteiro.
    if (cheio !== 'CANCELLED' && cheio !== 'CONCLUDED') await receberPedido(integ, ev.orderId);
    return;
  }
  if (codigo === 'HSD' || cheio === 'HANDSHAKE_DISPUTE') {
    await db().query(`UPDATE pedidos_externos SET disputa = $2, atualizado_em = now() WHERE id = $1`, [pe.id, JSON.stringify({ ...(ev.metadata || {}), recebida_em: new Date().toISOString() })]);
    return;
  }
  if (codigo === 'HSS' || cheio === 'HANDSHAKE_SETTLEMENT') {
    await db().query(`UPDATE pedidos_externos SET disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
    return;
  }
  if (!STATUS_POR_CODIGO[codigo] && !Object.values(STATUS_POR_CODIGO).includes(cheio)) return; // outros grupos: so reconhece
  await db().query(`UPDATE pedidos_externos SET status_externo = $2, confirmado = confirmado OR $2 <> 'PLACED', atualizado_em = now() WHERE id = $1`, [pe.id, cheio]);
  if (cheio === 'CANCELLED') await cancelarLocal(pe, 'Cancelado no iFood');
}

// Um ciclo de polling de uma conexao: busca eventos, trata e so entao confirma o recebimento (ACK).
// Evento que falhou nao recebe ACK: o iFood entrega de novo no proximo ciclo.
async function sincronizar(integ) {
  const token = await tokenDa(integ);
  const evs = await api.eventos(token, [integ.merchant_id]);
  const ok = [];
  let falhas = 0;
  for (const ev of evs) {
    if (!ev || !ev.id) continue;
    try { await tratarEvento(integ, ev); ok.push(ev.id); } catch (err) { falhas += 1; await registrarErro(integ.id, `evento ${ev.code || ''} do pedido ${ev.orderId || ''}: ${err.message}`); }
  }
  await api.confirmarRecebimento(token, ok);
  await db().query(`UPDATE integracoes_delivery SET ultimo_polling_em = now(), ultimo_erro = CASE WHEN $2 THEN NULL ELSE ultimo_erro END WHERE id = $1`, [integ.id, falhas === 0]);
  return { eventos: evs.length, tratados: ok.length, falhas };
}

// ---------------------------------------------------------------- disponibilidade no cardapio
// Produtos marcados "Vender no iFood" e complementos com codigo: disponivel quando ha estoque para ao menos 1 unidade
// na loja conectada (saldo - reservado), pela mesma regra da venda (ficha, combo, complementos). So as mudancas vao ao iFood.
async function calcularDisponibilidade(integ) {
  const prods = (await db().query(
    `SELECT id, nome, ativo, COALESCE(codigo_ifood, codigo_interno) AS codigo FROM products WHERE tenant_id = $1 AND vende_ifood`, [integ.tenant_id]
  )).rows;
  const comps = (await db().query(
    `SELECT c.id, c.nome, c.codigo, c.ativo AND g.ativo AS ativo FROM complementos c JOIN grupos_complementos g ON g.id = c.grupo_id
     WHERE c.tenant_id = $1 AND c.codigo IS NOT NULL`, [integ.tenant_id]
  )).rows;
  if (prods.length === 0 && comps.length === 0) return [];
  const reservados = await reservadosDaLoja(db(), integ.tenant_id, integ.location_id);
  const u = await unidadesDisponiveis(db(), integ.tenant_id, integ.location_id, prods.map((p) => p.id), comps.map((c) => c.id), reservados);
  const linha = (tipo, x, d) => {
    const temEstoque = !d || d.unidades === null || d.unidades >= 1;
    const status = x.ativo && temEstoque ? 'AVAILABLE' : 'UNAVAILABLE';
    const motivo = !x.ativo ? 'desativado no GiroStock' : !temEstoque ? `sem estoque${d.limitante ? ` (falta ${d.limitante})` : ''}` : null;
    return { tipo, id: x.id, nome: x.nome, codigo: String(x.codigo).toUpperCase(), status, motivo, unidades: d ? d.unidades : null };
  };
  return [...prods.map((p) => linha('item', p, u.produtos.get(p.id))), ...comps.map((c) => linha('complemento', c, u.complementos.get(c.id)))];
}

async function atualizarDisponibilidade(integ, { forcar = false } = {}) {
  const atual = await calcularDisponibilidade(integ);
  const enviados = new Map((await db().query(`SELECT tipo, codigo, status FROM ifood_disponibilidade WHERE integracao_id = $1`, [integ.id])).rows.map((r) => [`${r.tipo}:${r.codigo}`, r.status]));
  const mudou = atual.filter((x) => forcar || enviados.get(`${x.tipo}:${x.codigo}`) !== x.status);
  if (mudou.length === 0) return { enviados: 0, total: atual.length };
  const token = await tokenDa(integ);
  await api.alterarDisponibilidade(token, integ.merchant_id, mudou);
  for (const x of mudou) {
    await db().query(
      `INSERT INTO ifood_disponibilidade (integracao_id, tipo, codigo, status, motivo, atualizado_em) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (integracao_id, tipo, codigo) DO UPDATE SET status = EXCLUDED.status, motivo = EXCLUDED.motivo, atualizado_em = now()`,
      [integ.id, x.tipo, x.codigo, x.status, x.motivo]
    );
  }
  return { enviados: mudou.length, total: atual.length };
}

async function listaDisponibilidade(integ) {
  const atual = await calcularDisponibilidade(integ);
  const enviados = new Map((await db().query(`SELECT tipo, codigo, status, atualizado_em FROM ifood_disponibilidade WHERE integracao_id = $1`, [integ.id])).rows.map((r) => [`${r.tipo}:${r.codigo}`, r]));
  return atual.map((x) => {
    const e = enviados.get(`${x.tipo}:${x.codigo}`);
    return { ...x, no_ifood: e ? e.status : null, enviado_em: e ? e.atualizado_em : null };
  });
}

// ---------------------------------------------------------------- cardapio: enviar produtos do GiroStock ao iFood
// Produtos marcados "Vender no iFood" viram itens no cardapio do iFood com o codigo PDV (externalCode) = codigo do produto
// (codigo iFood ou codigo interno). Com isso os pedidos (inclusive os de teste) chegam com o codigo e entram sozinhos.
// Ids (UUID v4) gerados aqui e guardados em ifood_cardapio: reenviar atualiza o mesmo item (PUT /items e idempotente).
const codigoPdv = (p) => String(p.codigo_ifood || p.codigo_interno || '').trim().toUpperCase();

async function categoriaNoIfood(integ, token, chave, nome, existentes) {
  const ja = (await db().query(`SELECT categoria_ifood_id FROM ifood_categorias WHERE integracao_id = $1 AND chave = $2`, [integ.id, chave])).rows[0];
  if (ja) return ja.categoria_ifood_id;
  // categoria com o mesmo nome ja no iFood (criada a mao no portal): usa ela
  const igual = existentes.find((c) => String(c.nome || '').trim().toLowerCase() === nome.trim().toLowerCase());
  const id = igual ? igual.id : (await api.criarCategoria(token, integ.merchant_id, nome)).id;
  if (!id) throw new HttpError(502, `o iFood não devolveu o id da categoria "${nome}"`);
  await db().query(
    `INSERT INTO ifood_categorias (integracao_id, chave, categoria_ifood_id, nome) VALUES ($1, $2, $3, $4)
     ON CONFLICT (integracao_id, chave) DO UPDATE SET categoria_ifood_id = EXCLUDED.categoria_ifood_id, nome = EXCLUDED.nome`,
    [integ.id, chave, id, nome]
  );
  return id;
}

async function produtosDoCardapio(integ, ids = null) {
  const params = [integ.tenant_id];
  let filtro = 'p.vende_ifood';
  if (ids) { params.push(ids); filtro = `p.id = ANY($${params.length}::uuid[])`; }
  return (await db().query(
    `SELECT p.id, p.nome, p.descricao, p.codigo_interno, p.codigo_ifood, p.preco_venda, p.ativo, p.vende_ifood, p.categoria_id, c.nome AS categoria_nome,
            p.imagem_id, img.mime AS imagem_mime
     FROM products p LEFT JOIN categories c ON c.id = p.categoria_id LEFT JOIN lv_imagens img ON img.id = p.imagem_id
     WHERE p.tenant_id = $1 AND ${filtro} ORDER BY c.nome NULLS LAST, p.nome`, params
  )).rows;
}

// Envia (cria ou atualiza) os produtos ao cardapio do iFood. ids: so esses (e marca "Vender no iFood"); sem ids: todos os marcados.
async function enviarCardapio(user, integ, ids = null) {
  if (ids && ids.length) {
    await db().query(`UPDATE products SET vende_ifood = true WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [integ.tenant_id, ids]);
  }
  const prods = await produtosDoCardapio(integ, ids && ids.length ? ids : null);
  if (prods.length === 0) throw new HttpError(400, 'nenhum produto marcado para vender no iFood');
  const token = await tokenDa(integ);
  const infoPreco = await precos.infoDePrecoDaLoja(db(), integ.tenant_id, integ.location_id, prods.map((p) => ({ id: p.id, preco_venda: p.preco_venda })));
  const disp = new Map((await calcularDisponibilidade(integ)).filter((x) => x.tipo === 'item').map((x) => [x.id, x.status]));
  const existentes = await api.categorias(token, integ.merchant_id).catch(() => []);
  const noIfoodPorCodigo = new Map(existentes.flatMap((c) => c.itens || []).filter((i) => i.codigo && i.id).map((i) => [i.codigo, i]));
  const resultado = [];
  // codigos repetidos nao podem ir (o iFood exige externalCode unico por loja)
  const vistos = new Map();
  for (const p of prods) {
    const codigo = codigoPdv(p);
    try {
      if (!codigo) throw new Error('produto sem código (preencha o código PDV do iFood ou o código interno)');
      if (vistos.has(codigo)) throw new Error(`código ${codigo} repetido com "${vistos.get(codigo)}"`);
      vistos.set(codigo, p.nome);
      const ip = infoPreco.get(p.id);
      if (ip && ip.vende === false) throw new Error('a loja conectada não vende este produto (preço por loja)');
      const preco = Number(ip ? ip.preco_venda : p.preco_venda);
      const ja = (await db().query(`SELECT item_id, produto_ifood_id, imagem_enviada, enviado_em FROM ifood_cardapio WHERE integracao_id = $1 AND product_id = $2`, [integ.id, p.id])).rows[0];
      // item com este codigo ja no iFood (criado no portal ou numa conexao anterior): atualiza ele em vez de criar outro
      const noIfood = noIfoodPorCodigo.get(codigo);
      const itemId = noIfood ? noIfood.id : ja && ja.enviado_em ? ja.item_id : crypto.randomUUID();
      const prodId = noIfood && noIfood.produtoId ? noIfood.produtoId : ja && ja.enviado_em ? ja.produto_ifood_id : crypto.randomUUID();
      const catId = await categoriaNoIfood(integ, token, p.categoria_id || 'sem-categoria', p.categoria_nome || 'Produtos', existentes);
      const status = p.ativo && disp.get(p.id) !== 'UNAVAILABLE' ? 'AVAILABLE' : 'UNAVAILABLE';
      const produto = { id: prodId, name: String(p.nome).slice(0, 100), description: String(p.descricao || '').slice(0, 1000), externalCode: codigo };
      // foto: so jpg/png (o iFood nao aceita webp); vai em base64 so quando mudou
      let imagemEnviada = ja ? ja.imagem_enviada : null;
      if (p.imagem_id && ['image/jpeg', 'image/png'].includes(p.imagem_mime) && (!ja || ja.imagem_enviada !== p.imagem_id)) {
        const img = (await db().query(`SELECT dados FROM lv_imagens WHERE id = $1`, [p.imagem_id])).rows[0];
        if (img && img.dados.length <= 5 * 1024 * 1024) { produto.image = `data:${p.imagem_mime};base64,${img.dados.toString('base64')}`; imagemEnviada = p.imagem_id; }
      }
      await api.salvarItem(token, integ.merchant_id, {
        item: { id: itemId, type: 'DEFAULT', categoryId: catId, status, price: { value: Number(preco.toFixed(2)) }, externalCode: codigo },
        products: [produto], optionGroups: [], options: [],
      });
      await db().query(
        `INSERT INTO ifood_cardapio (integracao_id, product_id, item_id, produto_ifood_id, codigo, categoria_ifood_id, preco, status, imagem_enviada, enviado_em, erro)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL)
         ON CONFLICT (integracao_id, product_id) DO UPDATE SET item_id = EXCLUDED.item_id, produto_ifood_id = EXCLUDED.produto_ifood_id, codigo = EXCLUDED.codigo,
           categoria_ifood_id = EXCLUDED.categoria_ifood_id, preco = EXCLUDED.preco, status = EXCLUDED.status, imagem_enviada = EXCLUDED.imagem_enviada, enviado_em = now(), erro = NULL`,
        [integ.id, p.id, itemId, prodId, codigo, catId, preco, status, imagemEnviada]
      );
      // a disponibilidade enviada passa a ser esta (o ciclo so manda mudancas depois)
      await db().query(
        `INSERT INTO ifood_disponibilidade (integracao_id, tipo, codigo, status, motivo, atualizado_em) VALUES ($1, 'item', $2, $3, NULL, now())
         ON CONFLICT (integracao_id, tipo, codigo) DO UPDATE SET status = EXCLUDED.status, atualizado_em = now()`, [integ.id, codigo, status]
      );
      resultado.push({ id: p.id, nome: p.nome, codigo, ok: true, preco, status });
    } catch (err) {
      const msg = err instanceof ErroPlataforma ? `iFood: ${err.message}` : err.message;
      await db().query(
        `INSERT INTO ifood_cardapio (integracao_id, product_id, item_id, produto_ifood_id, codigo, erro) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (integracao_id, product_id) DO UPDATE SET erro = EXCLUDED.erro`,
        [integ.id, p.id, crypto.randomUUID(), crypto.randomUUID(), codigo || '-', String(msg).slice(0, 300)]
      );
      resultado.push({ id: p.id, nome: p.nome, codigo, ok: false, erro: msg });
      if (err instanceof ErroPlataforma && (err.status === 401 || err.status === 403)) break; // sem acesso: para tudo
    }
  }
  await db().query(`UPDATE integracoes_delivery SET cardapio_enviado_em = now() WHERE id = $1`, [integ.id]);
  await logAudit(db(), { tenantId: integ.tenant_id, usuarioId: user ? user.id : null, acao: 'ifood_enviar_cardapio', recurso: 'integracoes_delivery', recursoId: integ.id, detalhes: { enviados: resultado.filter((r) => r.ok).length, erros: resultado.filter((r) => !r.ok).length } });
  return { enviados: resultado.filter((r) => r.ok).length, erros: resultado.filter((r) => !r.ok).length, itens: resultado };
}

// Lista para a tela: produtos do GiroStock (com codigo, preco da loja) e o que esta no iFood.
async function listaCardapio(integ) {
  const prods = (await db().query(
    `SELECT p.id, p.nome, p.codigo_interno, p.codigo_ifood, p.preco_venda, p.ativo, p.vende_ifood, c.nome AS categoria_nome, p.imagem_id IS NOT NULL AS tem_foto
     FROM products p LEFT JOIN categories c ON c.id = p.categoria_id WHERE p.tenant_id = $1 AND p.ativo ORDER BY c.nome NULLS LAST, p.nome LIMIT 2000`, [integ.tenant_id]
  )).rows;
  const infoPreco = await precos.infoDePrecoDaLoja(db(), integ.tenant_id, integ.location_id, prods.map((p) => ({ id: p.id, preco_venda: p.preco_venda })));
  const env = new Map((await db().query(`SELECT * FROM ifood_cardapio WHERE integracao_id = $1`, [integ.id])).rows.map((r) => [r.product_id, r]));
  return prods.map((p) => {
    const e = env.get(p.id);
    const ip = infoPreco.get(p.id);
    const preco = Number(ip ? ip.preco_venda : p.preco_venda);
    return {
      id: p.id, nome: p.nome, categoria: p.categoria_nome, codigo: codigoPdv(p), vende_ifood: p.vende_ifood, tem_foto: p.tem_foto, preco,
      no_ifood: !!(e && e.enviado_em),
      preco_no_ifood: e && e.preco !== null ? Number(e.preco) : null, desatualizado: !!(e && e.enviado_em && e.preco !== null && Number(e.preco) !== preco),
      enviado_em: e ? e.enviado_em : null, erro: e ? e.erro : null,
    };
  });
}

// Precos que mudaram no GiroStock desde o envio: atualiza no iFood (lote pelo codigo PDV).
async function atualizarPrecos(integ) {
  const env = (await db().query(`SELECT product_id, codigo, preco FROM ifood_cardapio WHERE integracao_id = $1 AND enviado_em IS NOT NULL AND erro IS NULL`, [integ.id])).rows;
  if (env.length === 0) return { enviados: 0 };
  const prods = (await db().query(`SELECT id, preco_venda FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [integ.tenant_id, env.map((e) => e.product_id)])).rows;
  const info = await precos.infoDePrecoDaLoja(db(), integ.tenant_id, integ.location_id, prods.map((p) => ({ id: p.id, preco_venda: p.preco_venda })));
  const mudou = env.filter((e) => info.get(e.product_id) && Number(info.get(e.product_id).preco_venda) !== Number(e.preco))
    .map((e) => ({ product_id: e.product_id, codigo: e.codigo, preco: Number(info.get(e.product_id).preco_venda) }));
  if (mudou.length === 0) return { enviados: 0 };
  await api.alterarPrecos(await tokenDa(integ), integ.merchant_id, mudou);
  for (const m of mudou) await db().query(`UPDATE ifood_cardapio SET preco = $3, enviado_em = now() WHERE integracao_id = $1 AND product_id = $2`, [integ.id, m.product_id, m.preco]);
  return { enviados: mudou.length };
}

// Ciclo de todas as conexoes ativas de empresas com o modulo "iFood e 99Food" ligado.
let rodando = false;
async function cicloGeral() {
  if (rodando || !api.configurado()) return;
  rodando = true;
  try {
    const { rows } = await db().query(`SELECT i.* FROM integracoes_delivery i JOIN tenants t ON t.id = i.tenant_id WHERE i.plataforma = 'ifood' AND i.status = 'conectado' AND t.status = 'ativa'`);
    for (const integ of rows) {
      try {
        const emp = await dadosDaEmpresa(db(), integ.tenant_id);
        if (!emp || !efetivos(emp).recursos.delivery_apps) continue;
        await sincronizar(integ);
        // Pausa/reativa no cardapio do iFood o que acabou/voltou (falha aqui nao impede o recebimento de pedidos).
        try { await atualizarDisponibilidade(integ); } catch (err) { await registrarErro(integ.id, `disponibilidade no cardápio: ${err.message}`); }
        try { await atualizarPrecos(integ); } catch (err) { await registrarErro(integ.id, `preços no cardápio: ${err.message}`); }
      } catch (err) {
        await registrarErro(integ.id, err.message).catch(() => {});
      }
    }
  } finally {
    rodando = false;
  }
}

let timer = null;
function iniciarPolling() {
  if (timer || process.env.IFOOD_POLLING === 'desligado') return;
  // O iFood pede polling a cada 30 s (homologacao). Menor que isso so para o simulador local.
  const seg = Math.max(Number(process.env.IFOOD_POLLING_SEGUNDOS) || 30, process.env.IFOOD_API_URL ? 2 : 30);
  timer = setInterval(() => { cicloGeral().catch(() => {}); }, seg * 1000);
  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------- acoes vindas do GiroStock
// Chamado pela tela de Pedidos ao mudar o status de um pedido do iFood, ANTES de gravar a mudanca:
// se o iFood recusar, a mudanca nao acontece (as duas pontas ficam iguais).
async function aoMudarStatus(order, para) {
  const pe = (await db().query(`SELECT * FROM pedidos_externos WHERE order_id = $1`, [order.id])).rows[0];
  if (!pe || !pe.integracao_id) return;
  const integ = await integracao(pe.integracao_id);
  if (integ.status !== 'conectado') throw new HttpError(409, 'o iFood desta loja está desconectado: reconecte em Lojas & PDVs');
  const token = await tokenDa(integ);
  try {
    if (para === 'em_preparo') {
      if (!pe.confirmado) await confirmarNoIfood(integ, pe);
      await api.iniciarPreparo(token, pe.externo_id);
    } else if (para === 'pronto') {
      // Pronto: obrigatorio na retirada/consumo no local; na entrega do iFood avisa o entregador. Entrega da loja: so o despacho.
      if (pe.payload.orderType !== 'DELIVERY' || pe.entrega_pela_plataforma) await api.prontoParaRetirada(token, pe.externo_id);
    } else if (para === 'saiu_entrega') {
      if (!pe.entrega_pela_plataforma) await api.despachar(token, pe.externo_id);
    }
  } catch (err) {
    if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou a mudança: ${err.message}`);
    throw err;
  }
}

async function aceitar(user, pe) {
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await confirmarNoIfood(integ, pe); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou: ${err.message}`); throw err; }
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_aceitar_pedido', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo: pe.codigo_externo } });
}

async function motivos(user, pe) {
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { return await api.motivosCancelamento(await tokenDa(integ), pe.externo_id); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `não foi possível buscar os motivos no iFood: ${err.message}`); throw err; }
}

// Cancelar pela loja: pede ao iFood (com o motivo da lista dele). O cancelamento local acontece quando o iFood
// confirmar (evento CAN); ate la o pedido fica marcado como "cancelamento solicitado".
async function solicitarCancelamento(user, pe, codigo, descricao) {
  if (!codigo) throw new HttpError(400, 'escolha o motivo do cancelamento (lista do iFood)');
  const integ = await integracao(pe.integracao_id, user.tenantId);
  try { await api.solicitarCancelamento(await tokenDa(integ), pe.externo_id, String(codigo), String(descricao || '').slice(0, 250)); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou o cancelamento: ${err.message}`); throw err; }
  await db().query(`UPDATE pedidos_externos SET status_externo = 'CANCELLATION_REQUESTED', atualizado_em = now() WHERE id = $1`, [pe.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: 'ifood_solicitar_cancelamento', recurso: 'pedidos_externos', recursoId: pe.id, detalhes: { codigo_motivo: codigo, motivo: descricao } });
}

async function responderDisputa(user, pe, aceitar) {
  if (!pe.disputa || !(pe.disputa.disputeId || pe.disputa.id)) throw new HttpError(409, 'não há pedido de cancelamento do cliente em aberto');
  const integ = await integracao(pe.integracao_id, user.tenantId);
  const motivo = aceitar && Array.isArray(pe.disputa.acceptCancellationReasons) && pe.disputa.acceptCancellationReasons[0] ? pe.disputa.acceptCancellationReasons[0] : undefined;
  try { await api.responderDisputa(await tokenDa(integ), pe.disputa.disputeId || pe.disputa.id, aceitar, motivo); } catch (err) { if (err instanceof ErroPlataforma) throw new HttpError(502, `o iFood não aceitou a resposta: ${err.message}`); throw err; }
  await db().query(`UPDATE pedidos_externos SET disputa = NULL, atualizado_em = now() WHERE id = $1`, [pe.id]);
  await logAudit(db(), { tenantId: user.tenantId, usuarioId: user.id, acao: aceitar ? 'ifood_aceitar_cancelamento_cliente' : 'ifood_recusar_cancelamento_cliente', recurso: 'pedidos_externos', recursoId: pe.id });
  if (aceitar) await cancelarLocal(pe, 'Cancelamento pedido pelo cliente (aceito pela loja)');
}

const mapear = pedidoDoIfood;
const produtosDosItens = (client, tenantId, itens) => comum.produtosDosItens(client, tenantId, itens, PLATAFORMA);

module.exports = {
  tokenDa, mapear, confirmarPedido: confirmarNoIfood,
  iniciarConexao, concluirConexao, escolherLoja, desconectar, sincronizar, cicloGeral, iniciarPolling, integracao,
  aoMudarStatus, pedidoExternoDoPedido, pedidoExterno, aceitar, motivos, solicitarCancelamento, responderDisputa, vincular,
  importar, produtosDosItens, PLATAFORMA, atualizarDisponibilidade, listaDisponibilidade, enviarCardapio, listaCardapio, atualizarPrecos,
};
