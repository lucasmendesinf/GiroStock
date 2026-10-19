// Loja virtual: regras usadas pela API publica (/api/loja/v1, o site) e pelo gerenciamento no sistema.
// Roda SEMPRE no banco de producao (o site e os pagamentos sao reais; o modo teste nao recebe pedidos do site).
//
// - Chave da API: identifica a loja (empresa). Guardada so como hash.
// - Horario: a loja recebe pedidos quando esta publicada, nao pausada e dentro do horario (fuso de Sao Paulo).
// - Preco no site: preco de venda do sistema ou o promocional (dentro do periodo) + complementos escolhidos.
// - Disponibilidade: a mesma regra do PDV/iFood (saldo do estabelecimento da loja - pedidos em aberto, ficha, combo).
// - Pedido: vira um pedido comum (origem 'loja_virtual') que reserva o estoque. Loja cardapio: cai na tela de Pedidos;
//   loja varejo: fluxo de loja online na aba Pedidos do site (services/pedidosSite.js), sem o modulo Pedidos.
// - Pagamento online (Mercado Pago, conta do lojista): Pix ou cartao. Pedido pago so no site: o preparo so comeca
//   com o pagamento aprovado; Pix nao pago no prazo cancela o pedido (libera a reserva).
const crypto = require('crypto');
const pool = require('../db/pool');
const { dadosDaEmpresa, efetivos } = require('../utils/limites');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { isQuantidadeValidaParaUnidade } = require('../utils/validators');
const { reservadosDaLoja } = require('../utils/reservas');
const {
  carregarComposicao, consumoDasLinhas, validarComplementos, precoDosComplementos, idsDeComplementos, saldosDaLoja, faltasDoConsumo, unidadesDisponiveis,
} = require('./consumo');
const { cifrar, decifrar } = require('./totp');
const mp = require('../integracoes/mercadopago');
const frete = require('./frete');
const meApi = require('../integracoes/melhorenvio');

const db = () => pool.producao;
const FUSO = 'America/Sao_Paulo';
const n2 = (v) => Number(Number(v || 0).toFixed(2));
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

// ---------- chave da API ----------
const hashChave = (chave) => crypto.createHash('sha256').update(String(chave)).digest('hex');
function gerarChave() {
  const chave = `lv_${crypto.randomBytes(24).toString('hex')}`;
  return { chave, hash: hashChave(chave), prefixo: chave.slice(0, 11) };
}

// Modulo ligado e empresa ativa.
async function moduloLigado(tenantId) {
  const emp = await dadosDaEmpresa(db(), tenantId);
  return !!(emp && emp.status === 'ativa' && efetivos(emp).recursos.loja_virtual);
}

// Loja pela chave enviada pelo site. Sem chave/invalida: 401. Modulo desligado ou empresa suspensa: 403.
async function lojaPorChave(chave) {
  if (!chave || !/^lv_[0-9a-f]{48}$/.test(String(chave))) throw new HttpError(401, 'chave da loja ausente ou inválida');
  const { rows } = await db().query(`SELECT * FROM lv_lojas WHERE api_chave_hash = $1`, [hashChave(chave)]);
  if (rows.length === 0) throw new HttpError(401, 'chave da loja ausente ou inválida');
  if (!(await moduloLigado(rows[0].tenant_id))) throw new HttpError(403, 'loja virtual indisponível para esta empresa');
  return rows[0];
}

// ---------- endereco da loja (subdominio, dominio proprio, pre-visualizacao) ----------
// O mesmo servidor atende o sistema e todas as lojas: a loja e escolhida pelo endereco acessado.
// LOJA_DOMINIO_BASE: dominio da plataforma para os subdominios gratis (ex.: lojas.calutec.com.br -> joao.lojas.calutec.com.br).
const dominioBase = () => String(process.env.LOJA_DOMINIO_BASE || '').trim().toLowerCase().replace(/^\*\./, '');
const SUBDOMINIO_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const SUBDOMINIOS_RESERVADOS = ['www', 'api', 'admin', 'app', 'sistema', 'painel', 'mail', 'email', 'ftp', 'cpanel', 'webmail', 'loja', 'lojas', 'master', 'suporte'];

function normalizarSubdominio(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!SUBDOMINIO_RE.test(s)) throw new HttpError(400, 'subdomínio inválido: de 3 a 40 letras, números ou hífen (sem acento nem espaço)');
  if (SUBDOMINIOS_RESERVADOS.includes(s)) throw new HttpError(400, `o subdomínio "${s}" é reservado`);
  return s;
}
// Sugestao de subdominio a partir do nome da empresa ("JA Conveniência" -> "ja-conveniencia").
const sugerirSubdominio = (nome) => semAcento(nome).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loja';

function normalizarDominio(v) {
  const d = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new HttpError(400, `domínio inválido: "${v}" (ex.: www.minhaloja.com.br)`);
  const base = dominioBase();
  if (base && (d === base || d.endsWith(`.${base}`))) throw new HttpError(400, 'use o campo subdomínio para endereços da própria plataforma');
  return d;
}

// Cache curto (o roteamento consulta a cada pagina aberta): host -> id da loja ou null.
const cacheHost = new Map();
const limparCacheHost = () => cacheHost.clear();
async function lojaIdDoHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h) return null;
  const c = cacheHost.get(h);
  if (c && Date.now() - c.em < 30000) return c.id;
  let id = null;
  const base = dominioBase();
  if (base && h.endsWith(`.${base}`)) {
    const sub = h.slice(0, -(base.length + 1));
    if (SUBDOMINIO_RE.test(sub)) id = ((await db().query(`SELECT id FROM lv_lojas WHERE lower(subdominio) = $1`, [sub])).rows[0] || {}).id || null;
  } else {
    // www.x.com e x.com valem como o mesmo dominio
    const alternativo = h.startsWith('www.') ? h.slice(4) : `www.${h}`;
    id = ((await db().query(`SELECT loja_id FROM lv_dominios WHERE dominio = $1 OR dominio = $2 ORDER BY dominio = $1 DESC LIMIT 1`, [h, alternativo])).rows[0] || {}).loja_id || null;
  }
  if (cacheHost.size > 5000) cacheHost.clear();
  cacheHost.set(h, { id, em: Date.now() });
  return id;
}

async function lojaValida(where, param) {
  const { rows } = await db().query(`SELECT * FROM lv_lojas WHERE ${where}`, [param]);
  if (rows.length === 0) throw new HttpError(404, 'loja não encontrada');
  if (!(await moduloLigado(rows[0].tenant_id))) throw new HttpError(403, 'loja virtual indisponível para esta empresa');
  return rows[0];
}
const lojaPorSubdominio = (sub) => lojaValida('lower(subdominio) = $1', String(sub || '').toLowerCase());
async function lojaPorHost(host) {
  const id = await lojaIdDoHost(host);
  if (!id) throw new HttpError(404, 'loja não encontrada');
  return lojaValida('id = $1', id);
}

// Loja da empresa (cria a configuracao na primeira vez, com um subdominio sugerido pelo nome e ainda livre).
async function lojaDaEmpresa(dbc, tenantId) {
  const atual = (await dbc.query(`SELECT * FROM lv_lojas WHERE tenant_id = $1`, [tenantId])).rows[0];
  if (atual) return atual;
  const t = (await dbc.query(`SELECT nome FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  const nome = t ? t.nome : '';
  let sub = sugerirSubdominio(nome);
  if (sub.length < 3 || SUBDOMINIOS_RESERVADOS.includes(sub)) sub = `loja-${sub}`.slice(0, 40);
  for (let i = 2; (await dbc.query(`SELECT 1 FROM lv_lojas WHERE lower(subdominio) = $1`, [sub])).rows.length > 0; i++) sub = `${sugerirSubdominio(nome).slice(0, 35)}-${i}`;
  const { rows } = await dbc.query(
    `INSERT INTO lv_lojas (tenant_id, nome, subdominio) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id RETURNING *`,
    [tenantId, nome, sub]
  );
  return rows[0];
}
const dominiosDaLoja = async (dbc, lojaId) => (await dbc.query(`SELECT dominio FROM lv_dominios WHERE loja_id = $1 ORDER BY criado_em, dominio`, [lojaId])).rows.map((r) => r.dominio);

// Enderecos da loja (para o painel e para o Master).
// sistema: endereco publico do GiroStock (URL_PUBLICA ou o da requisicao), base do link /loja/<subdominio>.
// link_principal (o que se compartilha): dominio proprio > subdominio da plataforma > link no endereco do sistema.
function enderecosDaLoja(loja, dominios = [], sistema = '') {
  const base = dominioBase();
  const urlSub = base && loja.subdominio ? `https://${loja.subdominio}.${base}` : null;
  const urlLink = sistema && loja.subdominio ? `${String(process.env.URL_PUBLICA || sistema).replace(/\/+$/, '')}/loja/${loja.subdominio}` : null;
  const urlsDominios = dominios.map((d) => `https://${d}`);
  return {
    subdominio: loja.subdominio || null,
    url_subdominio: urlSub,
    url_link: urlLink,
    dominios,
    urls_dominios: urlsDominios,
    dominio_base: base || null,
    link_principal: urlsDominios[0] || urlSub || urlLink,
  };
}

// ---------- tema (layout) ----------
// O tipo da loja (Master) define os modelos: varejo = grade | vitrine | lista; cardapio = layout de cardapio digital
// (categorias em cartoes com foto, itens em lista). Cores, fonte, cantos e blocos da pagina inicial valem para os dois.
const COR_RE = /^#[0-9a-f]{6}$/i;
const MODELOS = { varejo: ['grade', 'vitrine', 'lista'], cardapio: ['cardapio'] };
const FONTES = ['moderna', 'classica', 'arredondada'];
const BLOCOS = ['banners', 'categorias', 'destaques', 'promocoes', 'produtos'];
const BLOCOS_PADRAO = {
  varejo: BLOCOS.map((tipo) => ({ tipo, ativo: true, titulo: '' })),
  cardapio: ['banners', 'destaques', 'categorias', 'promocoes', 'produtos'].map((tipo) => ({ tipo, ativo: ['banners', 'destaques', 'categorias'].includes(tipo), titulo: tipo === 'destaques' ? 'Mais pedidos' : '' })),
};
const TEMA_PADRAO = {
  modelo: 'grade', cor_primaria: '#b5121b', cor_fundo: '#ffffff', cor_texto: '#1d1d1f', cor_destaque: '#1f7a4d', cor_topo: '#111111',
  fonte: 'moderna', cantos: 'arredondados', blocos: BLOCOS_PADRAO.varejo, exclusivo: null,
};
const tipoValido = (tipo) => (tipo === 'cardapio' ? 'cardapio' : 'varejo');
// Fluxo dos pedidos do site: cardapio vai para a tela de Pedidos (cozinha); varejo e loja online (Pedidos do site).
const fluxoDaLoja = (loja) => (tipoValido(loja.tipo) === 'cardapio' ? 'cardapio' : 'ecommerce');
// Mescla o tema guardado com o padrao do tipo (campos novos ganham o valor padrao sem migracao).
function temaEfetivo(t, tipo = 'varejo') {
  const tp = tipoValido(tipo);
  const x = t && typeof t === 'object' ? t : {};
  const blocos = Array.isArray(x.blocos) ? x.blocos.filter((b) => b && BLOCOS.includes(b.tipo)) : BLOCOS_PADRAO[tp].map((b) => ({ ...b }));
  for (const b of BLOCOS) if (!blocos.some((y) => y.tipo === b)) blocos.push({ tipo: b, ativo: false, titulo: '' });
  const r = {
    ...TEMA_PADRAO, ...Object.fromEntries(Object.entries(x).filter(([k]) => k in TEMA_PADRAO && k !== 'blocos')),
    blocos: blocos.map((b) => ({ tipo: b.tipo, ativo: b.ativo !== false, titulo: String(b.titulo || '').slice(0, 60) })),
  };
  // modelo de outro tipo (ex.: a loja mudou de varejo para cardapio): volta ao padrao do tipo
  if (!MODELOS[tp].includes(r.modelo)) r.modelo = MODELOS[tp][0];
  return r;
}
// Valida o que o cliente envia (o tema exclusivo so o Master define).
function normalizarTema(entrada, atual, tipo = 'varejo') {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) throw new HttpError(400, 'tema inválido');
  const tp = tipoValido(tipo);
  if (entrada.modelo !== undefined && !MODELOS[tp].includes(entrada.modelo)) throw new HttpError(400, 'modelo de layout inválido para este tipo de loja');
  const base = temaEfetivo(atual, tp);
  const t = temaEfetivo({ ...base, ...entrada, exclusivo: base.exclusivo }, tp);
  if (!FONTES.includes(t.fonte)) throw new HttpError(400, 'fonte inválida');
  if (!['arredondados', 'retos'].includes(t.cantos)) throw new HttpError(400, 'cantos inválidos');
  for (const k of ['cor_primaria', 'cor_fundo', 'cor_texto', 'cor_destaque', 'cor_topo']) {
    if (!COR_RE.test(t[k])) throw new HttpError(400, `cor inválida em ${k.replace('cor_', '')}: use #RRGGBB`);
    t[k] = t[k].toLowerCase();
  }
  if (Array.isArray(entrada.blocos)) {
    const ordem = entrada.blocos.map((b) => b && b.tipo).filter((x) => BLOCOS.includes(x));
    t.blocos.sort((a, b) => (ordem.indexOf(a.tipo) + 99 * (ordem.indexOf(a.tipo) < 0)) - (ordem.indexOf(b.tipo) + 99 * (ordem.indexOf(b.tipo) < 0)));
  }
  return t;
}

// ---------- horario ----------
// Agora em Sao Paulo: dia da semana (0 = domingo), minutos do dia e data AAAA-MM-DD.
function agoraSP(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { dia, minutos: Number(p.hour) * 60 + Number(p.minute), data: `${p.year}-${p.month}-${p.day}` };
}
const minutosDe = (hhmm) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Valida e normaliza os horarios: { "0": [{ de, ate }], ... }. ate <= de = passa da meia-noite.
function normalizarHorarios(h) {
  if (h === undefined || h === null) return {};
  if (typeof h !== 'object' || Array.isArray(h)) throw new HttpError(400, 'horários inválidos');
  const r = {};
  for (const [dia, faixas] of Object.entries(h)) {
    if (!/^[0-6]$/.test(dia)) throw new HttpError(400, 'horários: dia da semana inválido (0 = domingo a 6 = sábado)');
    if (!Array.isArray(faixas)) throw new HttpError(400, 'horários inválidos');
    if (faixas.length > 3) throw new HttpError(400, 'horários: no máximo 3 faixas por dia');
    r[dia] = faixas.map((f) => {
      if (minutosDe(f && f.de) === null || minutosDe(f && f.ate) === null) throw new HttpError(400, 'horários: use HH:MM (ex.: 18:00)');
      if (f.de === f.ate) throw new HttpError(400, 'horários: início e fim iguais');
      return { de: f.de, ate: f.ate };
    });
  }
  return r;
}

// Aberta agora? Sem nenhum horario cadastrado = sempre aberta. Devolve tambem quando fecha e a proxima abertura.
function situacaoHorario(horarios, agora = agoraSP()) {
  const h = horarios || {};
  const dias = Object.keys(h).filter((k) => Array.isArray(h[k]) && h[k].length > 0);
  if (dias.length === 0) return { aberta: true, sempre_aberta: true, fecha_as: null, proxima_abertura: null };
  const hoje = h[String(agora.dia)] || [];
  const ontem = h[String((agora.dia + 6) % 7)] || [];
  for (const f of hoje) {
    const de = minutosDe(f.de);
    const ate = minutosDe(f.ate);
    if (ate > de ? agora.minutos >= de && agora.minutos < ate : agora.minutos >= de) return { aberta: true, sempre_aberta: false, fecha_as: f.ate, proxima_abertura: null };
  }
  for (const f of ontem) {
    const de = minutosDe(f.de);
    const ate = minutosDe(f.ate);
    if (ate <= de && agora.minutos < ate) return { aberta: true, sempre_aberta: false, fecha_as: f.ate, proxima_abertura: null };
  }
  for (let i = 0; i < 8; i++) {
    const dia = (agora.dia + i) % 7;
    const faixas = (h[String(dia)] || []).map((f) => minutosDe(f.de)).filter((m) => i > 0 || m > agora.minutos).sort((a, b) => a - b);
    if (faixas.length > 0) {
      return { aberta: false, sempre_aberta: false, fecha_as: null, proxima_abertura: { dia: i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DIAS[dia], dia_semana: dia, hora: hhmm(faixas[0]) } };
    }
  }
  return { aberta: false, sempre_aberta: false, fecha_as: null, proxima_abertura: null };
}

// Recebendo pedidos agora? Devolve o motivo quando nao.
function recebendoPedidos(loja) {
  const hor = situacaoHorario(loja.horarios);
  if (!loja.publicada) return { ok: false, motivo: 'a loja está fora do ar', horario: hor };
  if (!loja.location_id) return { ok: false, motivo: 'a loja ainda não está configurada para receber pedidos', horario: hor };
  if (loja.pausada) return { ok: false, motivo: 'a loja não está recebendo pedidos no momento', horario: hor };
  if (!hor.aberta) {
    const p = hor.proxima_abertura;
    return { ok: false, motivo: p ? `a loja está fechada: abre ${p.dia} às ${p.hora}` : 'a loja está fechada', horario: hor };
  }
  return { ok: true, motivo: null, horario: hor };
}

// ---------- preco ----------
// Promocao valida hoje (e menor que o preco normal) -> preco promocional; senao o preco de venda do sistema.
function precoDoProduto(p, hoje = agoraSP().data) {
  const normal = n2(p.preco_venda);
  const promo = p.preco_promocional === null || p.preco_promocional === undefined ? null : n2(p.preco_promocional);
  const ini = p.promo_inicio ? String(p.promo_inicio).slice(0, 10) : null;
  const fim = p.promo_fim ? String(p.promo_fim).slice(0, 10) : null;
  const ativa = promo !== null && promo < normal && (!ini || ini <= hoje) && (!fim || fim >= hoje);
  return { preco: ativa ? promo : normal, preco_original: ativa ? normal : null, promocao_ate: ativa ? fim : null };
}

// ---------- catalogo ----------
const urlImagem = (base, id) => `${base}/api/loja/v1/imagens/${id}`;

const SELECT_PRODUTO = `
  SELECT p.id, p.nome AS nome_cadastro, p.unidade, p.preco_venda, p.categoria_id, p.grade_id, p.variacao, c.nome AS categoria_nome, c.parent_id AS categoria_pai_id,
         cp.nome AS categoria_pai_nome, lp.nome_site, lp.descricao, lp.imagens, lp.preco_promocional, lp.promo_inicio::text, lp.promo_fim::text,
         lp.destaque, lp.ordem, lp.maior_idade, lp.so_retirada,
         COALESCE((SELECT json_agg(json_build_object('id', g.id, 'nome', g.nome, 'minimo', g.minimo, 'maximo', g.maximo,
                     'opcoes', (SELECT COALESCE(json_agg(json_build_object('id', o.id, 'nome', o.nome, 'preco', o.preco) ORDER BY o.ordem, o.nome), '[]')
                                FROM complementos o WHERE o.grupo_id = g.id AND o.ativo)) ORDER BY pg.ordem, g.nome)
                   FROM produto_grupos pg JOIN grupos_complementos g ON g.id = pg.grupo_id WHERE pg.product_id = p.id AND g.ativo), '[]') AS complementos
  FROM products p
  JOIN lv_produtos lp ON lp.product_id = p.id
  LEFT JOIN categories c ON c.id = p.categoria_id
  LEFT JOIN categories cp ON cp.id = c.parent_id
  WHERE p.tenant_id = $1 AND p.ativo AND lp.publicado`;

// Disponibilidade de uma lista de produtos no estabelecimento da loja (unidades que ainda da para vender).
async function disponibilidade(loja, ids) {
  if (!loja.location_id || ids.length === 0) return new Map();
  const reservados = await reservadosDaLoja(db(), loja.tenant_id, loja.location_id);
  return (await unidadesDisponiveis(db(), loja.tenant_id, loja.location_id, ids, [], reservados)).produtos;
}

function produtoPublico(r, disp, base, hoje) {
  const preco = precoDoProduto(r, hoje);
  const d = disp.get(r.id);
  const unidades = d ? d.unidades : 0;
  return {
    id: r.id,
    nome: r.nome_site || r.nome_cadastro,
    descricao: r.descricao || '',
    unidade: r.unidade,
    categoria: r.categoria_id ? { id: r.categoria_id, nome: r.categoria_nome, pai: r.categoria_pai_id ? { id: r.categoria_pai_id, nome: r.categoria_pai_nome } : null } : null,
    ...preco,
    imagens: (r.imagens || []).map((id) => urlImagem(base, id)),
    destaque: !!r.destaque,
    maior_idade: !!r.maior_idade, // +18: o cliente declara a idade ao fechar o pedido
    so_retirada: !!r.so_retirada, // nao pode ser entregue nem enviado
    disponivel: unidades === null || unidades > 0,
    quantidade_maxima: unidades === null ? 99 : Math.min(unidades, 99),
    variacao: r.variacao || null,
    complementos: (r.complementos || []).map((g) => ({ ...g, opcoes: g.opcoes.map((o) => ({ ...o, preco: n2(o.preco) })) })),
  };
}

// Lista do site. filtros: { categoria, busca, destaque, ids, pagina, por_pagina, ordem }
async function catalogo(loja, base, filtros = {}) {
  const params = [loja.tenant_id];
  let where = '';
  if (filtros.categoria) {
    params.push(filtros.categoria);
    where += ` AND (p.categoria_id = $${params.length}::uuid OR c.parent_id = $${params.length}::uuid)`;
  }
  if (filtros.busca) {
    params.push(`%${String(filtros.busca).trim().slice(0, 60)}%`);
    where += ` AND (p.nome ILIKE $${params.length} OR lp.nome_site ILIKE $${params.length} OR lp.descricao ILIKE $${params.length}
               OR (p.grade_id IS NOT NULL AND EXISTS (SELECT 1 FROM products p3 WHERE p3.grade_id = p.grade_id AND p3.ativo AND p3.nome ILIKE $${params.length})))`;
  }
  if (filtros.destaque) where += ' AND lp.destaque';
  if (filtros.promocao) {
    params.push(agoraSP().data);
    where += ` AND lp.preco_promocional IS NOT NULL AND lp.preco_promocional < p.preco_venda AND (lp.promo_inicio IS NULL OR lp.promo_inicio <= $${params.length}::date) AND (lp.promo_fim IS NULL OR lp.promo_fim >= $${params.length}::date)`;
  }
  if (filtros.ids) {
    params.push(filtros.ids);
    where += ` AND p.id = ANY($${params.length}::uuid[])`;
  }
  if (filtros.grade) {
    params.push(filtros.grade);
    where += ` AND p.grade_id = $${params.length}::uuid`;
  }
  // Grade de variacoes: um produto so no site (a primeira variacao publicada representa a grade; as outras vem em "grade").
  if (!filtros.ids) where += SQL_REPRESENTANTE;
  const porPagina = Math.min(Math.max(Number(filtros.por_pagina) || 24, 1), 100);
  const pagina = Math.max(Number(filtros.pagina) || 1, 1);
  const hoje = agoraSP().data;
  const ordem = {
    nome: 'COALESCE(lp.nome_site, p.nome)',
    menor_preco: `CASE WHEN lp.preco_promocional IS NOT NULL AND lp.preco_promocional < p.preco_venda AND (lp.promo_inicio IS NULL OR lp.promo_inicio <= '${hoje}') AND (lp.promo_fim IS NULL OR lp.promo_fim >= '${hoje}') THEN lp.preco_promocional ELSE p.preco_venda END, COALESCE(lp.nome_site, p.nome)`,
    maior_preco: `CASE WHEN lp.preco_promocional IS NOT NULL AND lp.preco_promocional < p.preco_venda AND (lp.promo_inicio IS NULL OR lp.promo_inicio <= '${hoje}') AND (lp.promo_fim IS NULL OR lp.promo_fim >= '${hoje}') THEN lp.preco_promocional ELSE p.preco_venda END DESC, COALESCE(lp.nome_site, p.nome)`,
  }[filtros.ordem] || 'lp.destaque DESC, lp.ordem, COALESCE(lp.nome_site, p.nome)';
  const total = Number((await db().query(`SELECT COUNT(*) AS n FROM (${SELECT_PRODUTO}${where}) x`, params)).rows[0].n);
  const { rows } = await db().query(`${SELECT_PRODUTO}${where} ORDER BY ${ordem}, p.id LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`, params);
  const disp = await disponibilidade(loja, rows.map((r) => r.id));
  const produtos = rows.map((r) => produtoPublico(r, disp, base, hoje));
  await juntarGrades(loja, base, hoje, rows, produtos);
  return { pagina, por_pagina: porPagina, total, paginas: Math.ceil(total / porPagina), produtos };
}

const SQL_REPRESENTANTE = ` AND (p.grade_id IS NULL OR p.id = (SELECT p2.id FROM products p2 JOIN lv_produtos lp2 ON lp2.product_id = p2.id
                              WHERE p2.grade_id = p.grade_id AND p2.ativo AND lp2.publicado ORDER BY p2.criado_em, p2.id LIMIT 1))`;

// Produto de grade no site: nome e fotos da grade, preco "a partir de" (o menor), disponivel se alguma variacao tiver
// estoque, e a lista de variacoes (atributos, preco, estoque e fotos de cada uma) para os seletores da pagina.
async function juntarGrades(loja, base, hoje, rows, produtos) {
  const gradeIds = [...new Set(rows.filter((r) => r.grade_id).map((r) => r.grade_id))];
  if (gradeIds.length === 0) return;
  const vrows = (await db().query(`${SELECT_PRODUTO} AND p.grade_id = ANY($2::uuid[]) ORDER BY p.criado_em, p.id`, [loja.tenant_id, gradeIds])).rows;
  const disp = await disponibilidade(loja, vrows.map((v) => v.id));
  const info = new Map((await db().query(
    `SELECT g.id, g.nome, g.atributos, lg.nome_site, lg.atributo_foto, COALESCE(lg.imagens, '{}') AS imagens FROM produto_grades g LEFT JOIN lv_grades lg ON lg.grade_id = g.id WHERE g.id = ANY($1::uuid[])`,
    [gradeIds]
  )).rows.map((g) => [g.id, g]));
  for (let i = 0; i < rows.length; i++) {
    const gid = rows[i].grade_id;
    if (!gid) continue;
    const g = info.get(gid);
    const vars = vrows.filter((v) => v.grade_id === gid).map((v) => produtoPublico(v, disp, base, hoje));
    if (!g || vars.length === 0) continue;
    const precos = vars.map((v) => v.preco);
    const menor = vars.reduce((a, b) => (b.preco < a.preco ? b : a));
    // so os valores que tem variacao no site, na ordem do cadastro
    const atributos = g.atributos.map((a) => ({ nome: a.nome, valores: a.valores.filter((x) => vars.some((v) => v.variacao && v.variacao[a.nome] === x)) })).filter((a) => a.valores.length);
    produtos[i] = {
      ...produtos[i],
      nome: g.nome_site || g.nome,
      imagens: g.imagens.length ? g.imagens.map((id) => urlImagem(base, id)) : produtos[i].imagens,
      preco: menor.preco, preco_original: menor.preco_original, preco_varia: Math.min(...precos) !== Math.max(...precos),
      disponivel: vars.some((v) => v.disponivel),
      grade: {
        id: gid, atributos, atributo_foto: g.atributo_foto || null,
        variacoes: vars.map((v) => ({ id: v.id, variacao: v.variacao, preco: v.preco, preco_original: v.preco_original, disponivel: v.disponivel, quantidade_maxima: v.quantidade_maxima, imagens: v.imagens })),
      },
    };
  }
}

// Produto pela id. Variacao de grade: devolve a grade inteira com a variacao pedida em "selecionada".
async function produto(loja, base, id) {
  const gradeId = ((await db().query(`SELECT grade_id FROM products WHERE id = $1 AND tenant_id = $2`, [id, loja.tenant_id])).rows[0] || {}).grade_id;
  const r = gradeId ? await catalogo(loja, base, { grade: gradeId, por_pagina: 1 }) : await catalogo(loja, base, { ids: [id], por_pagina: 1 });
  if (r.produtos.length === 0) throw new HttpError(404, 'produto não encontrado');
  const p = r.produtos[0];
  if (p.grade) p.grade.selecionada = p.grade.variacoes.some((v) => v.id === id) ? id : null;
  return p;
}

// Categorias com produto publicado (e as categorias pai delas), com a contagem.
async function categorias(loja, base) {
  const hoje = agoraSP().data;
  const { rows } = await db().query(
    `WITH pub AS (
       SELECT p.id, COALESCE(p.grade_id, p.id) AS item, p.categoria_id, lp.imagens, lp.destaque,
              (lp.preco_promocional IS NOT NULL AND lp.preco_promocional < p.preco_venda AND (lp.promo_inicio IS NULL OR lp.promo_inicio <= $2::date)
               AND (lp.promo_fim IS NULL OR lp.promo_fim >= $2::date)) AS promo
       FROM products p JOIN lv_produtos lp ON lp.product_id = p.id
       WHERE p.tenant_id = $1 AND p.ativo AND lp.publicado AND p.categoria_id IS NOT NULL),
     dela AS (  -- produtos da categoria e das filhas dela
       SELECT c.id AS cat, pub.* FROM categories c JOIN categories f ON f.id = c.id OR f.parent_id = c.id JOIN pub ON pub.categoria_id = f.id
       WHERE c.tenant_id = $1)
     SELECT c.id, c.nome, c.parent_id, COALESCE(lc.ordem, 0) AS ordem, lc.imagem_id,
            (SELECT COUNT(DISTINCT dela.item)::int FROM dela WHERE dela.cat = c.id) AS produtos, -- grade conta uma vez
            EXISTS (SELECT 1 FROM dela WHERE dela.cat = c.id AND dela.promo) AS tem_promocao,
            (SELECT dela.imagens[1] FROM dela WHERE dela.cat = c.id AND cardinality(dela.imagens) > 0 ORDER BY dela.destaque DESC, dela.id LIMIT 1) AS foto_produto
     FROM categories c LEFT JOIN lv_categorias lc ON lc.category_id = c.id
     WHERE c.tenant_id = $1 AND NOT COALESCE(lc.oculta, false) AND EXISTS (SELECT 1 FROM dela WHERE dela.cat = c.id)
     ORDER BY COALESCE(lc.ordem, 0), c.nome`,
    [loja.tenant_id, hoje]
  );
  return rows.map((r) => ({
    id: r.id, nome: r.nome, pai_id: r.parent_id, produtos: Number(r.produtos), tem_promocao: r.tem_promocao,
    // foto da categoria; sem ela, a foto de um produto dela
    imagem: r.imagem_id ? urlImagem(base, r.imagem_id) : r.foto_produto ? urlImagem(base, r.foto_produto) : null,
  }));
}

// Dados publicos da loja para o site.
async function dadosPublicos(loja, base) {
  const situacao = recebendoPedidos(loja);
  const regioes = (await db().query(`SELECT id, nome, taxa, tempo_extra_min, pedido_minimo FROM lv_regioes WHERE tenant_id = $1 AND ativo ORDER BY nome`, [loja.tenant_id])).rows;
  const pag = loja.pagamentos || {};
  const mpOk = !!(loja.mp_access_token_cript && loja.mp_public_key);
  return {
    id: loja.id,
    nome: loja.nome,
    descricao: loja.descricao,
    tipo: tipoValido(loja.tipo),
    tema: temaEfetivo(loja.tema, loja.tipo),
    logo: loja.logo_id ? urlImagem(base, loja.logo_id) : null,
    banners: (loja.banners || []).map((b) => ({ imagem: urlImagem(base, b.imagem_id), titulo: b.titulo || '', link: b.link || '' })),
    contato: { telefone: loja.telefone, whatsapp: loja.whatsapp, email: loja.email, endereco: loja.endereco, instagram: loja.instagram },
    aviso: loja.aviso,
    maior_idade: !!loja.site_maior_idade, // pergunta a idade ao entrar no site
    no_ar: !!loja.publicada,
    recebendo_pedidos: situacao.ok,
    motivo_fechada: situacao.motivo,
    horario: situacao.horario,
    horarios: loja.horarios || {},
    retirada: { aceita: !!loja.aceita_retirada, tempo_estimado_min: loja.tempo_preparo_min },
    entrega: {
      aceita: !!loja.aceita_entrega || frete.envioDisponivel(loja),
      local: !!loja.aceita_entrega,
      // envio por transportadora (Melhor Envio): cotacao pelo CEP no carrinho/checkout
      transportadora: frete.envioDisponivel(loja) ? {
        gratis_acima: loja.envio_gratis_acima === null ? null : n2(loja.envio_gratis_acima),
        cidade_entrega_local: loja.aceita_entrega ? (loja.envio_remetente || {}).cidade || null : null,
      } : null,
      tempo_estimado_min: loja.tempo_preparo_min + loja.tempo_entrega_min,
      bairros: regioes.map((r) => ({ id: r.id, nome: r.nome, taxa: n2(r.taxa), tempo_estimado_min: loja.tempo_preparo_min + loja.tempo_entrega_min + r.tempo_extra_min, pedido_minimo: r.pedido_minimo === null ? null : n2(r.pedido_minimo) })),
      outros_bairros: loja.taxa_outros_bairros === null ? null : { taxa: n2(loja.taxa_outros_bairros) },
    },
    pedido_minimo: n2(loja.pedido_minimo),
    pagamentos: {
      pix_online: !!pag.pix_online && mpOk,
      cartao_online: !!pag.cartao_online && mpOk,
      na_entrega: Array.isArray(pag.na_entrega) ? pag.na_entrega : [],
      parcelas_max: loja.parcelas_max,
      pix_desconto_pct: pag.pix_online && mpOk ? Number(loja.pix_desconto_pct || 0) : 0,
      mercadopago_public_key: mpOk ? loja.mp_public_key : null,
    },
  };
}

// ---------- carrinho ----------
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Taxa e prazo da entrega pelo bairro (lista da loja; fora dela, a taxa de "outros bairros" se houver).
async function entregaDoBairro(dbc, loja, bairro) {
  const alvo = semAcento(bairro);
  if (!alvo) throw new HttpError(400, 'informe o bairro da entrega');
  const regioes = (await dbc.query(`SELECT id, nome, taxa, tempo_extra_min, pedido_minimo FROM lv_regioes WHERE tenant_id = $1 AND ativo`, [loja.tenant_id])).rows;
  const r = regioes.find((x) => semAcento(x.nome) === alvo);
  if (r) return { regiao_id: r.id, bairro: r.nome, taxa: n2(r.taxa), tempo_extra_min: r.tempo_extra_min, pedido_minimo: r.pedido_minimo === null ? null : n2(r.pedido_minimo) };
  if (loja.taxa_outros_bairros !== null && loja.taxa_outros_bairros !== undefined) return { regiao_id: null, bairro: String(bairro).trim(), taxa: n2(loja.taxa_outros_bairros), tempo_extra_min: 0, pedido_minimo: null };
  throw new HttpError(422, `não fazemos entrega no bairro "${String(bairro).trim()}"`);
}

// Validacao do cupom. Devolve { cupom } ou lanca HttpError(422) com o motivo.
async function validarCupom(dbc, loja, codigo, conta, subtotal, tipo) {
  const { rows } = await dbc.query(`SELECT *, inicio::text AS inicio, fim::text AS fim FROM lv_cupons WHERE tenant_id = $1 AND upper(codigo) = upper($2)`, [loja.tenant_id, String(codigo).trim()]);
  const c = rows[0];
  if (!c || !c.ativo) throw new HttpError(422, 'cupom inválido');
  const hoje = agoraSP().data;
  if (c.inicio && c.inicio > hoje) throw new HttpError(422, 'este cupom ainda não está valendo');
  if (c.fim && c.fim < hoje) throw new HttpError(422, 'este cupom expirou');
  if (subtotal < n2(c.pedido_minimo)) throw new HttpError(422, `este cupom vale para pedidos a partir de R$ ${n2(c.pedido_minimo).toFixed(2).replace('.', ',')}`);
  if (c.tipo === 'frete_gratis' && tipo !== 'entrega') throw new HttpError(422, 'este cupom é de frete grátis: vale só para entrega');
  if (c.limite_total !== null) {
    const usos = Number((await dbc.query(`SELECT COUNT(*) AS n FROM orders WHERE cupom_id = $1 AND status <> 'cancelado'`, [c.id])).rows[0].n);
    if (usos >= c.limite_total) throw new HttpError(422, 'este cupom já atingiu o limite de usos');
  }
  if (c.limite_por_cliente !== null || c.primeira_compra) {
    if (!conta) throw new HttpError(422, 'entre na sua conta para usar este cupom');
    if (c.limite_por_cliente !== null) {
      const meus = Number((await dbc.query(`SELECT COUNT(*) AS n FROM orders WHERE cupom_id = $1 AND lv_conta_id = $2 AND status <> 'cancelado'`, [c.id, conta.id])).rows[0].n);
      if (meus >= c.limite_por_cliente) throw new HttpError(422, 'você já usou este cupom');
    }
    if (c.primeira_compra) {
      const pedidos = Number((await dbc.query(`SELECT COUNT(*) AS n FROM orders WHERE lv_conta_id = $1 AND status <> 'cancelado'`, [conta.id])).rows[0].n);
      if (pedidos > 0) throw new HttpError(422, 'este cupom vale só para a primeira compra');
    }
  }
  return c;
}

function descontoDoCupom(c, subtotal, taxa) {
  if (c.tipo === 'frete_gratis') return n2(taxa);
  if (c.tipo === 'valor') return n2(Math.min(n2(c.valor), subtotal));
  let d = n2((subtotal * n2(c.valor)) / 100);
  if (c.desconto_maximo !== null && c.desconto_maximo !== undefined) d = Math.min(d, n2(c.desconto_maximo));
  return n2(Math.min(d, subtotal));
}

// Calcula o carrinho com os precos e regras da loja.
// b: { itens: [{ product_id, quantidade, complementos: [{ id, quantidade }], observacao }], tipo: 'entrega'|'retirada', bairro, cidade, cep,
//      frete_servico (id do servico da transportadora; sem ele, entrega local pelo bairro), cupom }
// modo 'previa': problemas de cupom/minimo/estoque viram avisos (o site mostra); modo 'pedido': lanca erro.
async function calcularCarrinho(dbc, loja, conta, b, modo = 'previa') {
  const avisos = [];
  const falha = (status, msg) => { if (modo === 'pedido') throw new HttpError(status, msg); avisos.push(msg); };
  if (!Array.isArray(b.itens) || b.itens.length === 0) throw new HttpError(400, 'o carrinho está vazio');
  if (b.itens.length > 60) throw new HttpError(400, 'carrinho com itens demais');
  const tipo = b.tipo === 'entrega' ? 'entrega' : 'retirada';
  const envio = frete.envioDisponivel(loja);
  if (tipo === 'entrega' && !loja.aceita_entrega && !envio) throw new HttpError(422, 'esta loja não faz entrega');
  if (tipo === 'retirada' && !loja.aceita_retirada) throw new HttpError(422, 'esta loja não aceita retirada');

  const linhas = b.itens.map((i) => {
    if (!i || typeof i.product_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(i.product_id) || !(Number(i.quantidade) > 0)) throw new HttpError(400, 'item do carrinho inválido');
    const comps = Array.isArray(i.complementos) ? i.complementos : [];
    if (comps.some((c) => !c || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.id))) throw new HttpError(400, 'complemento inválido');
    return {
      product_id: i.product_id, quantidade: Number(i.quantidade), observacao: String(i.observacao || '').trim().slice(0, 200),
      complementos_pedidos: comps.map((c) => ({ id: c.id, quantidade: Math.max(1, Math.floor(Number(c.quantidade) || 1)) })),
    };
  });
  const ids = [...new Set(linhas.map((l) => l.product_id))];
  const prods = new Map((await dbc.query(
    `SELECT p.id, p.nome, p.unidade, p.preco_venda, lp.nome_site, lp.imagens, lp.preco_promocional, lp.promo_inicio::text, lp.promo_fim::text, lp.maior_idade, lp.so_retirada
     FROM products p JOIN lv_produtos lp ON lp.product_id = p.id WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) AND p.ativo AND lp.publicado`,
    [loja.tenant_id, ids]
  )).rows.map((p) => [p.id, p]));
  const comp = await carregarComposicao(dbc, loja.tenant_id, ids, idsDeComplementos(linhas.map((l) => ({ complementos: l.complementos_pedidos }))));
  const hoje = agoraSP().data;
  const itens = [];
  for (const l of linhas) {
    const p = prods.get(l.product_id);
    if (!p) throw new HttpError(422, 'um dos produtos do carrinho não está mais à venda');
    const nome = p.nome_site || p.nome;
    if (!isQuantidadeValidaParaUnidade(l.quantidade, p.unidade)) throw new HttpError(400, `"${nome}" só aceita quantidade inteira`);
    if (l.quantidade > 999) throw new HttpError(400, `quantidade de "${nome}" muito alta`);
    try {
      l.complementos = validarComplementos(comp, l.product_id, l.complementos_pedidos);
    } catch (err) {
      throw new HttpError(422, err.message);
    }
    const { preco, preco_original: original } = precoDoProduto(p, hoje);
    l.preco_unitario = n2(preco + precoDosComplementos(l.complementos));
    itens.push({
      product_id: p.id, nome, quantidade: l.quantidade, preco_unitario: l.preco_unitario, preco_base: preco, preco_original: original,
      complementos: l.complementos.map((c) => ({ id: c.id, nome: c.nome, preco: n2(c.preco), quantidade: c.quantidade })),
      observacao: l.observacao, subtotal: n2(l.preco_unitario * l.quantidade), maior_idade: !!p.maior_idade, so_retirada: !!p.so_retirada,
    });
  }
  const subtotal = n2(itens.reduce((s, i) => s + i.subtotal, 0));
  // So retirada (ex.: tabaco): com um destes no carrinho, nada de entrega/envio.
  const soRetirada = itens.filter((i) => i.so_retirada).map((i) => i.nome);
  if (tipo === 'entrega' && soRetirada.length) falha(422, `${[...new Set(soRetirada)].join(', ')}: só retirada na loja (não entregamos este produto)`);
  const maiorIdade = itens.some((i) => i.maior_idade);

  // Estoque (previa sem travar; no pedido, criarPedido confere de novo travando os saldos).
  if (loja.location_id) {
    const consumo = consumoDasLinhas(comp, linhas);
    const reservados = await reservadosDaLoja(dbc, loja.tenant_id, loja.location_id);
    const disp = await saldosDaLoja(dbc, loja.tenant_id, loja.location_id, consumo, reservados);
    const faltas = await faltasDoConsumo(dbc, loja.tenant_id, consumo, disp, comp);
    for (const f of faltas) falha(409, f.tipo === 'produto' ? `sem estoque suficiente de ${f.nome}` : `um item do carrinho está indisponível no momento (falta ${f.nome})`);
  } else {
    falha(409, 'a loja ainda não está configurada para receber pedidos');
  }

  let entrega = { tipo, taxa: 0, bairro: null, regiao_id: null, tempo_estimado_min: loja.tempo_preparo_min, servico: null };
  let minimo = n2(loja.pedido_minimo);
  let opcoesEnvio = null; // transportadoras (Melhor Envio) para o CEP
  let local = null; // entrega da propria loja pelo bairro
  let freteInterno = null; // custo e pacotes da cotacao (vao para o pedido/etiqueta; nao para o site)
  if (tipo === 'entrega') {
    if (loja.aceita_entrega && b.bairro) {
      if (!frete.entregaLocalNaCidade(loja, b.cidade)) {
        local = { disponivel: false, motivo: `a entrega da loja é só em ${(loja.envio_remetente || {}).cidade}` };
      } else {
        try {
          const e = await entregaDoBairro(dbc, loja, b.bairro);
          local = { disponivel: true, bairro: e.bairro, regiao_id: e.regiao_id, taxa: e.taxa, pedido_minimo: e.pedido_minimo, tempo_estimado_min: loja.tempo_preparo_min + loja.tempo_entrega_min + e.tempo_extra_min };
        } catch (err) {
          if (err.status !== 422) throw err;
          local = { disponivel: false, motivo: err.message };
        }
      }
    }
    if (envio && b.cep) {
      try {
        opcoesEnvio = await frete.opcoesDeEnvio(dbc, loja, b.cep, itens.map((i) => ({ product_id: i.product_id, quantidade: i.quantidade, preco_unitario: i.preco_unitario })), subtotal);
        if (opcoesEnvio.length === 0) avisos.push('nenhuma transportadora atende este CEP');
      } catch (err) {
        if (modo === 'pedido' && b.frete_servico) throw err;
        avisos.push(err.message);
      }
    }
    if (b.frete_servico) {
      const o = opcoesEnvio && opcoesEnvio.find((x) => x.id === Number(b.frete_servico));
      if (!envio) throw new HttpError(422, 'esta loja não envia por transportadora');
      if (!o) {
        falha(422, 'o frete escolhido não está disponível para este CEP: escolha outro');
      } else {
        entrega = { tipo, taxa: o.preco, bairro: null, regiao_id: null, tempo_estimado_min: null, servico: { id: o.id, nome: o.nome, prazo_dias: o.prazo_dias, gratis: o.gratis } };
        freteInterno = { custo: o.custo, pacotes: o.pacotes };
      }
    } else if (local && local.disponivel) {
      entrega = { tipo, taxa: local.taxa, bairro: local.bairro, regiao_id: local.regiao_id, tempo_estimado_min: local.tempo_estimado_min, servico: null };
      if (local.pedido_minimo !== null) minimo = local.pedido_minimo;
    } else if (!b.bairro && !b.cep) {
      if (modo === 'pedido') throw new HttpError(400, 'informe o endereço da entrega');
      entrega.tempo_estimado_min = loja.tempo_preparo_min + loja.tempo_entrega_min;
    } else if (opcoesEnvio && opcoesEnvio.length) {
      falha(422, local && !local.disponivel && !envio ? local.motivo : 'escolha uma opção de frete');
    } else {
      falha(422, local && !local.disponivel ? local.motivo : 'não entregamos neste endereço');
    }
  }
  if (subtotal < minimo) falha(422, `pedido mínimo de R$ ${minimo.toFixed(2).replace('.', ',')}`);

  let cupom = null;
  let desconto = 0;
  if (b.cupom && String(b.cupom).trim()) {
    try {
      const c = await validarCupom(dbc, loja, b.cupom, conta, subtotal, tipo);
      desconto = descontoDoCupom(c, subtotal, entrega.taxa);
      cupom = { id: c.id, codigo: c.codigo.toUpperCase(), descricao: c.descricao, tipo: c.tipo, valido: true, motivo: null };
    } catch (err) {
      if (modo === 'pedido' || err.status !== 422) throw err;
      cupom = { codigo: String(b.cupom).trim().toUpperCase(), valido: false, motivo: err.message };
    }
  }
  // Desconto no Pix pago pelo site: % sobre os produtos (depois do cupom), nao sobre o frete.
  const pctPix = Number(loja.pix_desconto_pct || 0);
  const basePix = n2(subtotal - (cupom && cupom.valido && cupom.tipo !== 'frete_gratis' ? desconto : 0));
  const descontoPix = pctPix > 0 && (loja.pagamentos || {}).pix_online && loja.mp_access_token_cript ? n2((basePix * pctPix) / 100) : 0;
  const comPix = b.pagamento === 'pix' && descontoPix > 0;
  const total = n2(subtotal + entrega.taxa - desconto - (comPix ? descontoPix : 0));
  const envioSite = tipo === 'entrega' && (envio || local) ? {
    transportadora: envio,
    opcoes: opcoesEnvio ? opcoesEnvio.map(({ id, nome, servico, transportadora, logo, preco, prazo_dias, gratis }) => ({ id, nome, servico, transportadora, logo, preco, prazo_dias, gratis })) : null,
    local: local ? { disponivel: local.disponivel, bairro: local.bairro || null, taxa: local.disponivel ? local.taxa : null, tempo_estimado_min: local.tempo_estimado_min || null, motivo: local.motivo || null } : null,
  } : null;
  return {
    itens, linhas, frete_interno: freteInterno, subtotal, taxa_entrega: entrega.taxa, desconto, total, cupom, entrega, envio: envioSite, pedido_minimo: minimo,
    // pix: desconto se pagar com Pix pelo site (aplicado no total quando b.pagamento = 'pix'); total_pix: o total pagando com Pix
    pix: descontoPix > 0 ? { percentual: pctPix, desconto: descontoPix, aplicado: comPix, total_pix: n2(subtotal + entrega.taxa - desconto - descontoPix) } : null,
    so_retirada: soRetirada.length > 0, maior_idade: maiorIdade,
    avisos: [...new Set(avisos)], pode_finalizar: avisos.length === 0,
  };
}

// ---------- Mercado Pago ----------
const tokenMp = (loja) => {
  if (!loja.mp_access_token_cript) throw new HttpError(422, 'pagamento online indisponível nesta loja');
  return decifrar(loja.mp_access_token_cript);
};
const segredoWebhook = (loja) => (loja.mp_webhook_secret_cript ? decifrar(loja.mp_webhook_secret_cript) : null);

function guardarCredenciaisMp(dados) {
  return {
    mp_access_token_cript: dados.access_token ? cifrar(dados.access_token) : null,
    mp_webhook_secret_cript: dados.webhook_secret ? cifrar(dados.webhook_secret) : null,
  };
}

// Situacao do pagamento no Mercado Pago -> situacao no pedido.
const SITUACAO_MP = { approved: 'aprovado', authorized: 'pendente', pending: 'pendente', in_process: 'pendente', in_mediation: 'aprovado', rejected: 'recusado', cancelled: 'expirado', refunded: 'estornado', charged_back: 'estornado' };

// Grava o retorno do Mercado Pago no pagamento e no pedido. Aprovado num pedido ja cancelado: estorna na hora.
async function aplicarPagamentoMp(loja, pagamentoId, dadosMp) {
  const client = await db().connect();
  let estornar = null;
  try {
    await client.query('BEGIN');
    const pg = (await client.query(`SELECT * FROM lv_pagamentos WHERE id = $1 FOR UPDATE`, [pagamentoId])).rows[0];
    if (!pg) { await client.query('ROLLBACK'); return null; }
    const o = (await client.query(`SELECT id, numero, status, pago, pagamento_status FROM orders WHERE id = $1 FOR UPDATE`, [pg.order_id])).rows[0];
    const st = String(dadosMp.status || '');
    const cartao = dadosMp.card || {};
    await client.query(
      `UPDATE lv_pagamentos SET status = $2, status_detalhe = $3, aprovado_em = CASE WHEN $2 = 'approved' AND aprovado_em IS NULL THEN now() ELSE aprovado_em END,
              estornado_em = CASE WHEN $2 IN ('refunded', 'charged_back') AND estornado_em IS NULL THEN now() ELSE estornado_em END,
              bandeira = COALESCE($4, bandeira), final_cartao = COALESCE($5, final_cartao), resposta = $6, atualizado_em = now()
       WHERE id = $1`,
      [pg.id, st, dadosMp.status_detail || null, dadosMp.payment_method_id || null, cartao.last_four_digits || null, JSON.stringify(resumoMp(dadosMp))]
    );
    const situacao = SITUACAO_MP[st] || 'pendente';
    if (situacao === 'aprovado') {
      if (o.status === 'cancelado') {
        estornar = pg; // pagou depois do cancelamento (ex.: Pix pago apos o prazo): devolve
      } else if (o.pagamento_status !== 'aprovado') {
        await client.query(`UPDATE orders SET pago = true, forma_pagamento_prevista = 'online', pagamento_online = $2, pagamento_status = 'aprovado', atualizado_em = now() WHERE id = $1`, [o.id, pg.metodo]);
        // Pagamento anterior ainda pendente (ex.: Pix gerado e depois pago no cartao): fica cancelado
        await client.query(`UPDATE lv_pagamentos SET status = 'cancelled', atualizado_em = now() WHERE order_id = $1 AND id <> $2 AND status IN ('pending', 'in_process')`, [o.id, pg.id]);
        await logAudit(client, { tenantId: loja.tenant_id, usuarioId: null, acao: 'loja_pagamento_aprovado', recurso: 'orders', recursoId: o.id, detalhes: { numero: o.numero, metodo: pg.metodo, valor: Number(pg.valor), mp_id: pg.provedor_id } });
      }
    } else if (situacao === 'estornado') {
      if (o.pagamento_status === 'aprovado' && o.status !== 'finalizado') await client.query(`UPDATE orders SET pago = false, pagamento_status = 'estornado', atualizado_em = now() WHERE id = $1`, [o.id]);
      else if (o.status === 'cancelado') await client.query(`UPDATE orders SET pagamento_status = 'estornado' WHERE id = $1`, [o.id]);
    } else if (o.pagamento_status !== 'aprovado' && o.status !== 'cancelado') {
      // recusado/expirado/pendente: so muda se nao ha outro pagamento aprovado
      await client.query(`UPDATE orders SET pagamento_status = $2, pagamento_online = $3, atualizado_em = now() WHERE id = $1`, [o.id, situacao, pg.metodo]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (estornar) {
    try {
      await mp.estornar(tokenMp(loja), estornar.provedor_id, `estorno-${estornar.id}`);
      await db().query(`UPDATE lv_pagamentos SET status = 'refunded', estornado_em = now(), atualizado_em = now() WHERE id = $1`, [estornar.id]);
      await db().query(`UPDATE orders SET pagamento_status = 'estornado' WHERE id = $1`, [estornar.order_id]);
    } catch (err) {
      console.error('loja virtual: estorno automático falhou', err.message);
    }
  }
  return pagamentoId;
}

// So o que interessa do retorno (sem dados sensiveis do pagador).
function resumoMp(d) {
  return {
    id: d.id, status: d.status, status_detail: d.status_detail, payment_method_id: d.payment_method_id, payment_type_id: d.payment_type_id,
    transaction_amount: d.transaction_amount, installments: d.installments, date_approved: d.date_approved, date_of_expiration: d.date_of_expiration,
    external_reference: d.external_reference,
  };
}

// Cria a cobranca no Mercado Pago para o pedido (Pix ou cartao). Devolve o pagamento (com o Pix copia e cola, se Pix).
async function cobrar(loja, pedido, conta, metodo, cartao, urlNotificacao) {
  const pag = loja.pagamentos || {};
  if (metodo === 'pix' && !pag.pix_online) throw new HttpError(422, 'esta loja não aceita Pix pelo site');
  if (metodo === 'cartao' && !pag.cartao_online) throw new HttpError(422, 'esta loja não aceita cartão pelo site');
  if (metodo === 'cartao') {
    if (!cartao || !cartao.token || !cartao.payment_method_id) throw new HttpError(400, 'dados do cartão ausentes (token e payment_method_id do Mercado Pago)');
    const parcelas = Number(cartao.parcelas || 1);
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > loja.parcelas_max) throw new HttpError(400, `parcelamento em até ${loja.parcelas_max}x`);
  }
  const token = tokenMp(loja);
  const valor = n2(pedido.total);
  const ins = await db().query(
    `INSERT INTO lv_pagamentos (tenant_id, order_id, metodo, status, valor, parcelas, expira_em)
     VALUES ($1, $2, $3, 'criando', $4, $5, $6) RETURNING id`,
    [loja.tenant_id, pedido.id, metodo, valor, metodo === 'cartao' ? Number(cartao.parcelas || 1) : null, metodo === 'pix' ? new Date(Date.now() + loja.pix_expira_min * 60000) : null]
  );
  const pagamentoId = ins.rows[0].id;
  const dados = {
    valor,
    descricao: `Pedido ${pedido.numero} - ${loja.nome || 'Loja virtual'}`.slice(0, 120),
    pagador: { email: conta.email, nome: conta.nome, cpf: conta.cpf },
    referencia: pedido.id,
    notificacao: urlNotificacao,
    idempotencia: pagamentoId,
    expira_em: new Date(Date.now() + loja.pix_expira_min * 60000),
    fatura: loja.nome,
    metadata: { pedido_numero: pedido.numero, pagamento_id: pagamentoId },
    cartao: metodo === 'cartao' ? cartao : undefined,
  };
  let r;
  try {
    r = metodo === 'pix' ? await mp.criarPix(token, dados) : await mp.criarCartao(token, dados);
  } catch (err) {
    await db().query(`UPDATE lv_pagamentos SET status = 'erro', status_detalhe = $2, atualizado_em = now() WHERE id = $1`, [pagamentoId, String(err.message).slice(0, 300)]);
    throw new HttpError(502, err.message);
  }
  const tx = (r.point_of_interaction && r.point_of_interaction.transaction_data) || {};
  await db().query(
    `UPDATE lv_pagamentos SET provedor_id = $2, pix_copia_cola = $3, pix_qr_base64 = $4, expira_em = COALESCE($5, expira_em), atualizado_em = now() WHERE id = $1`,
    [pagamentoId, String(r.id), tx.qr_code || null, tx.qr_code_base64 || null, r.date_of_expiration ? new Date(r.date_of_expiration) : null]
  );
  await aplicarPagamentoMp(loja, pagamentoId, r);
  return pagamentoPublico((await db().query(`SELECT * FROM lv_pagamentos WHERE id = $1`, [pagamentoId])).rows[0]);
}

const MOTIVO_RECUSA = {
  cc_rejected_insufficient_amount: 'saldo ou limite insuficiente',
  cc_rejected_bad_filled_security_code: 'código de segurança inválido',
  cc_rejected_bad_filled_date: 'data de validade inválida',
  cc_rejected_bad_filled_other: 'confira os dados do cartão',
  cc_rejected_call_for_authorize: 'o banco pediu autorização: ligue para o banco e tente de novo',
  cc_rejected_card_disabled: 'cartão desabilitado: ligue para o banco',
  cc_rejected_duplicated_payment: 'pagamento duplicado',
  cc_rejected_high_risk: 'pagamento recusado pela análise de segurança',
  cc_rejected_max_attempts: 'limite de tentativas atingido: use outro cartão',
  cc_rejected_other_reason: 'o banco recusou o pagamento',
};

function pagamentoPublico(p) {
  if (!p) return null;
  const pendente = ['pending', 'in_process', 'authorized'].includes(p.status);
  return {
    id: p.id,
    metodo: p.metodo,
    situacao: SITUACAO_MP[p.status] || (p.status === 'erro' ? 'erro' : 'pendente'),
    valor: n2(p.valor),
    parcelas: p.parcelas,
    bandeira: p.bandeira,
    final_cartao: p.final_cartao,
    motivo_recusa: p.status === 'rejected' ? MOTIVO_RECUSA[p.status_detalhe] || 'pagamento recusado' : null,
    pix: p.metodo === 'pix' && pendente ? { copia_e_cola: p.pix_copia_cola, qr_code_base64: p.pix_qr_base64, expira_em: p.expira_em } : null,
    aprovado_em: p.aprovado_em,
    criado_em: p.criado_em,
  };
}

// Estorno de pedido pago no site (cancelamento pela loja ou pelo cliente).
async function estornarPedido(loja, orderId) {
  const pg = (await db().query(`SELECT * FROM lv_pagamentos WHERE order_id = $1 AND status = 'approved' ORDER BY criado_em DESC LIMIT 1`, [orderId])).rows[0];
  if (!pg) return null;
  await mp.estornar(tokenMp(loja), pg.provedor_id, `estorno-${pg.id}`);
  await db().query(`UPDATE lv_pagamentos SET status = 'refunded', estornado_em = now(), atualizado_em = now() WHERE id = $1`, [pg.id]);
  return pg;
}

// Aviso do Mercado Pago (webhook): confere o pagamento direto na API (fonte de verdade) e aplica.
async function receberAvisoMp(lojaId, corpo, query, headers) {
  const loja = (await db().query(`SELECT * FROM lv_lojas WHERE id = $1`, [lojaId])).rows[0];
  if (!loja || !loja.mp_access_token_cript) return { ignorado: 'loja sem Mercado Pago' };
  const tipo = (corpo && (corpo.type || corpo.topic)) || query.type || query.topic;
  const dataId = String((corpo && corpo.data && corpo.data.id) || query['data.id'] || query.id || '');
  if (tipo && !['payment', 'pagamento'].includes(tipo)) return { ignorado: `tipo ${tipo}` };
  if (!dataId) return { ignorado: 'sem id' };
  const segredo = segredoWebhook(loja);
  if (segredo && !mp.assinaturaValida(segredo, headers['x-signature'], headers['x-request-id'], dataId)) throw new HttpError(401, 'assinatura inválida');
  const pg = (await db().query(`SELECT id FROM lv_pagamentos WHERE tenant_id = $1 AND provedor = 'mercadopago' AND provedor_id = $2`, [loja.tenant_id, dataId])).rows[0];
  if (!pg) return { ignorado: 'pagamento desconhecido' };
  const dados = await mp.consultar(tokenMp(loja), dataId);
  await aplicarPagamentoMp(loja, pg.id, dados);
  return { ok: true };
}

// Varredura: confere os pagamentos pendentes no Mercado Pago (caso um aviso tenha se perdido) e cancela os pedidos
// cujo pagamento online nao foi aprovado no prazo (libera a reserva de estoque).
async function varrerPagamentos() {
  const { rows } = await db().query(
    `SELECT o.id, o.tenant_id, o.numero, o.criado_em, o.pagamento_online, l.id AS loja_id, l.pix_expira_min,
            (SELECT max(p.expira_em) FROM lv_pagamentos p WHERE p.order_id = o.id) AS expira_em
     FROM orders o JOIN lv_lojas l ON l.tenant_id = o.tenant_id
     WHERE o.origem = 'loja_virtual' AND o.status = 'novo' AND o.pagamento_status IN ('pendente', 'recusado')`
  );
  for (const o of rows) {
    try {
      const loja = (await db().query(`SELECT * FROM lv_lojas WHERE id = $1`, [o.loja_id])).rows[0];
      const pendentes = (await db().query(`SELECT * FROM lv_pagamentos WHERE order_id = $1 AND provedor_id IS NOT NULL AND status IN ('pending', 'in_process', 'authorized')`, [o.id])).rows;
      for (const p of pendentes) {
        if (!loja.mp_access_token_cript) break;
        await aplicarPagamentoMp(loja, p.id, await mp.consultar(tokenMp(loja), p.provedor_id));
      }
      const atual = (await db().query(`SELECT status, pagamento_status FROM orders WHERE id = $1`, [o.id])).rows[0];
      if (atual.status !== 'novo' || atual.pagamento_status === 'aprovado') continue;
      // Prazo: o do Pix (+2 min de folga) ou, sem Pix pendente, o prazo configurado contado da criacao do pedido.
      const limite = o.expira_em ? new Date(o.expira_em).getTime() + 2 * 60000 : new Date(o.criado_em).getTime() + (o.pix_expira_min + 2) * 60000;
      if (Date.now() < limite) continue;
      for (const p of pendentes) { try { await mp.cancelar(tokenMp(loja), p.provedor_id); } catch { /* ja expirado la */ } }
      await cancelarPedido(loja, o.id, 'pagamento online não confirmado no prazo', { sistema: true, pagamentoStatus: 'expirado' });
    } catch (err) {
      console.error('loja virtual: varredura de pagamento', o.id, err.message);
    }
  }
}

// Cancela um pedido da loja (cliente, sistema ou equipe). Pago no site: estorna antes.
async function cancelarPedido(loja, orderId, motivo, opcoes = {}) {
  const atual = (await db().query(`SELECT id, numero, status, pagamento_status, sale_id FROM orders WHERE id = $1 AND tenant_id = $2`, [orderId, loja.tenant_id])).rows[0];
  if (!atual) throw new HttpError(404, 'pedido não encontrado');
  if (['finalizado', 'cancelado'].includes(atual.status)) throw new HttpError(409, 'este pedido já foi encerrado');
  if (atual.sale_id) throw new HttpError(409, 'o pedido já foi enviado e virou venda: para devolver, cancele a venda e estorne o pagamento');
  let estornado = false;
  if (atual.pagamento_status === 'aprovado') {
    try {
      estornado = !!(await estornarPedido(loja, orderId));
    } catch (err) {
      throw new HttpError(502, `não foi possível estornar o pagamento: ${err.message}`);
    }
  }
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const o = (await client.query(`SELECT id, numero, status, sale_id FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (['finalizado', 'cancelado'].includes(o.status) || o.sale_id) throw new HttpError(409, 'este pedido já foi encerrado');
    await client.query(
      `UPDATE orders SET status = 'cancelado', cancelado_em = now(), motivo_cancelamento = $2, atualizado_em = now(),
              pago = CASE WHEN $3 THEN false ELSE pago END,
              pagamento_status = CASE WHEN $3 THEN 'estornado' WHEN $4::text IS NOT NULL THEN $4 ELSE pagamento_status END
       WHERE id = $1`,
      [orderId, motivo, estornado, opcoes.pagamentoStatus || null]
    );
    await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, $2, 'cancelado', $3)`, [orderId, o.status, opcoes.usuarioId || null]);
    await logAudit(client, {
      tenantId: loja.tenant_id, usuarioId: opcoes.usuarioId || null, acao: 'cancelar_pedido', recurso: 'orders', recursoId: orderId,
      detalhes: { numero: o.numero, motivo, origem: 'loja_virtual', por: opcoes.sistema ? 'sistema' : opcoes.cliente ? 'cliente' : 'equipe', estornado },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { estornado };
}

// Etiquetas do Melhor Envio em andamento: atualiza a situacao e o codigo de rastreio (Jadlog e outras so tem codigo
// depois da postagem) e marca como entregue o pedido enviado que ja virou venda.
async function varrerEnvios() {
  const { rows } = await db().query(
    `SELECT o.id, o.tenant_id, o.numero, o.status, o.sale_id, o.me_envio_id, o.me_status, o.rastreio_codigo, o.transportadora, l.id AS loja_id
     FROM orders o JOIN lv_lojas l ON l.tenant_id = o.tenant_id
     WHERE o.me_envio_id IS NOT NULL AND o.status IN ('em_preparo', 'pronto', 'saiu_entrega') AND COALESCE(o.me_status, '') NOT IN ('delivered', 'canceled', 'expired')
       AND l.me_token_cript IS NOT NULL
     ORDER BY o.atualizado_em LIMIT 200`
  );
  const porLoja = new Map();
  for (const r of rows) { if (!porLoja.has(r.loja_id)) porLoja.set(r.loja_id, []); porLoja.get(r.loja_id).push(r); }
  for (const [lojaId, pedidos] of porLoja) {
    const loja = (await db().query(`SELECT * FROM lv_lojas WHERE id = $1`, [lojaId])).rows[0];
    let sit;
    try { sit = await meApi.rastrear(frete.cfgMe(loja), pedidos.map((p) => p.me_envio_id)); } catch (err) { console.error('loja virtual: rastreio Melhor Envio', err.message); continue; }
    for (const p of pedidos) {
      const t = sit[p.me_envio_id];
      if (!t) continue;
      const codigo = t.codigo || p.rastreio_codigo;
      await db().query(
        `UPDATE orders SET me_status = $2, rastreio_codigo = $3,
                rastreio_url = CASE WHEN $3::text IS NOT NULL AND (rastreio_url IS NULL OR rastreio_codigo IS DISTINCT FROM $3) THEN $4 ELSE rastreio_url END,
                atualizado_em = CASE WHEN me_status IS DISTINCT FROM $2 OR rastreio_codigo IS DISTINCT FROM $3 THEN now() ELSE atualizado_em END
         WHERE id = $1`,
        [p.id, t.status, codigo, meApi.urlRastreio(codigo)]
      );
      // entregue pela transportadora: pedido enviado (ja e venda) vira entregue
      if (t.status === 'delivered' && p.status === 'saiu_entrega' && p.sale_id) {
        const client = await db().connect();
        try {
          await client.query('BEGIN');
          const atual = (await client.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
          if (atual.status === 'saiu_entrega') {
            await client.query(`UPDATE orders SET status = 'finalizado', finalizado_em = now(), atualizado_em = now() WHERE id = $1`, [p.id]);
            await client.query(`INSERT INTO order_status_log (order_id, de, para, usuario_id) VALUES ($1, 'saiu_entrega', 'finalizado', NULL)`, [p.id]);
            await logAudit(client, { tenantId: p.tenant_id, usuarioId: null, acao: 'pedido_site_entregue', recurso: 'orders', recursoId: p.id, detalhes: { numero: p.numero, por: 'Melhor Envio' } });
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('loja virtual: marcar entregue', err.message);
        } finally {
          client.release();
        }
      }
    }
  }
}

let varreduraEnvios = null;
function iniciarVarreduraEnvios() {
  if (varreduraEnvios || process.env.LOJA_VARREDURA === 'desligado') return;
  const seg = Math.max(Number(process.env.LOJA_VARREDURA_ENVIOS_SEGUNDOS) || 900, 2);
  let rodando = false;
  varreduraEnvios = setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try { await varrerEnvios(); } catch (err) { console.error('loja virtual: varredura de envios', err.message); } finally { rodando = false; }
  }, seg * 1000);
  varreduraEnvios.unref();
}

let varredura = null;
function iniciarVarredura() {
  if (varredura || process.env.LOJA_VARREDURA === 'desligado') return;
  const seg = Math.max(Number(process.env.LOJA_VARREDURA_SEGUNDOS) || 60, 2);
  let rodando = false;
  varredura = setInterval(async () => {
    if (rodando) return;
    rodando = true;
    try { await varrerPagamentos(); } catch (err) { console.error('loja virtual: varredura', err.message); } finally { rodando = false; }
  }, seg * 1000);
  varredura.unref();
}

module.exports = {
  db, gerarChave, hashChave, moduloLigado, lojaPorChave, lojaPorHost, lojaPorSubdominio, lojaIdDoHost, limparCacheHost, dominioBase,
  lojaDaEmpresa, dominiosDaLoja, normalizarSubdominio, sugerirSubdominio, normalizarDominio, enderecosDaLoja, temaEfetivo, normalizarTema, TEMA_PADRAO, MODELOS, tipoValido, fluxoDaLoja, FONTES, BLOCOS, agoraSP, normalizarHorarios, situacaoHorario, recebendoPedidos, precoDoProduto,
  catalogo, produto, categorias, dadosPublicos, urlImagem, calcularCarrinho, entregaDoBairro, validarCupom, descontoDoCupom, semAcento,
  guardarCredenciaisMp, tokenMp, cobrar, pagamentoPublico, aplicarPagamentoMp, estornarPedido, receberAvisoMp, varrerPagamentos, cancelarPedido,
  iniciarVarredura, iniciarVarreduraEnvios, varrerEnvios, SITUACAO_MP, n2,
};
