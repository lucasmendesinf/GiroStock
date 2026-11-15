// WhatsApp, etapa 2: campanhas de marketing pela API oficial.
// - Para quem: um segmento de Clientes (em risco, inativos, aniversariantes, VIP...) ou clientes escolhidos. So entra quem
//   aceitou receber mensagens e tem celular; quem recebeu campanha nos ultimos 7 dias fica de fora (evita bloqueios).
// - Mensagem: um dos modelos de marketing aprovados pela Meta (whatsapp.js, MODELOS_MARKETING).
// - Cupom individual: cada cliente recebe um codigo proprio (ex.: VOLTA-7K2QX), de uso unico e com validade, que vale no
//   cardapio digital e na loja virtual (lv_cupons com customer_id; so o dono usa).
// - Envio: as mensagens entram na fila e saem aos poucos (a cada 5 s, ate 20 por vez); a Meta informa entregue/lida/falhou.
const crypto = require('crypto');
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { logAudit } = require('../utils/audit');
const { isUuid } = require('../utils/tenant');
const wa = require('./whatsapp');

const DIAS_ENTRE_CAMPANHAS = 7;
const MAX_POR_CAMPANHA = 2000;
const POR_VEZ = 20;
// Estimativa do custo por mensagem de marketing no Brasil (R$). So informativo: quem cobra e a Meta.
const custoUnitario = () => Number(process.env.WHATSAPP_CUSTO_MARKETING || 0.35);
const PREFIXO = { volta: 'VOLTA', aniversario: 'NIVER', oferta_cupom: 'OFERTA' };
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const brl = (v) => `R$ ${n2(v).toFixed(2).replace('.', ',')}`;
const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || 'cliente';
const modeloDa = (chave) => wa.MODELOS_MARKETING.find((m) => m.chave === chave);

function textoDesconto(tipo, valor) {
  if (tipo === 'frete_gratis') return 'frete grátis';
  if (tipo === 'valor') return `${brl(valor)} de desconto`;
  return `${String(n2(valor)).replace('.', ',')}% de desconto`;
}

// data "hoje + dias" no fuso de Sao Paulo (AAAA-MM-DD) e "DD/MM" para a mensagem
function dataValidade(dias) {
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const f = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + Math.max(0, dias - 1));
  const iso = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  const ini = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  return { inicio: ini, fim: iso, curta: `${iso.slice(8, 10)}/${iso.slice(5, 7)}` };
}

function codigoCupom(prefixo) {
  let s = '';
  for (const b of crypto.randomBytes(5)) s += ALFABETO[b % ALFABETO.length];
  return `${prefixo}-${s}`;
}

// Valida o corpo da campanha.
function lerCampanha(b) {
  const modelo = modeloDa(b.modelo);
  if (!modelo) throw new HttpError(400, 'escolha o modelo da mensagem');
  const nome = String(b.nome || '').trim().slice(0, 80) || modelo.titulo;
  const oferta = modelo.oferta ? String(b.oferta || '').trim().replace(/\s+/g, ' ') : null;
  if (modelo.oferta && (!oferta || oferta.length < 5)) throw new HttpError(400, 'escreva a oferta (ex.: X-Tudo + refri com 20% de desconto)');
  if (oferta && oferta.length > 200) throw new HttpError(400, 'a oferta pode ter até 200 caracteres');
  if (oferta && /[\n\t]|\s{4,}/.test(String(b.oferta))) throw new HttpError(400, 'a oferta não pode ter quebra de linha');
  let cupom = null;
  if (modelo.cupom) {
    const c = b.cupom || {};
    const tipo = ['percentual', 'valor', 'frete_gratis'].includes(c.tipo) ? c.tipo : null;
    if (!tipo) throw new HttpError(400, 'escolha o tipo do cupom');
    const valor = tipo === 'frete_gratis' ? 0 : n2(c.valor);
    if (tipo !== 'frete_gratis' && !(valor > 0)) throw new HttpError(400, 'informe o valor do desconto');
    if (tipo === 'percentual' && valor > 90) throw new HttpError(400, 'o desconto pode ser de até 90%');
    const validade = Math.floor(Number(c.validade_dias));
    if (!(validade >= 1 && validade <= 90)) throw new HttpError(400, 'a validade do cupom é de 1 a 90 dias');
    const minimo = n2(c.pedido_minimo);
    if (minimo < 0) throw new HttpError(400, 'pedido mínimo inválido');
    const prefixo = String(c.prefixo || PREFIXO[modelo.chave]).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || PREFIXO[modelo.chave];
    cupom = { tipo, valor, validade_dias: validade, pedido_minimo: minimo, prefixo };
  }
  const ids = Array.isArray(b.customer_ids) ? b.customer_ids.filter(isUuid).slice(0, MAX_POR_CAMPANHA) : [];
  const segmento = ids.length ? null : String(b.segmento || '').trim() || null;
  if (!segmento && !ids.length) throw new HttpError(400, 'escolha para quem enviar');
  return { modelo, nome, oferta, cupom, segmento, customer_ids: ids };
}

function parametros(modelo, { cliente, empresa, oferta, cupom, codigo }) {
  const val = cupom ? dataValidade(cupom.validade_dias).curta : null;
  if (modelo.chave === 'oferta') return [primeiroNome(cliente.nome), empresa, oferta];
  if (modelo.chave === 'oferta_cupom') return [primeiroNome(cliente.nome), empresa, oferta, codigo, val];
  return [primeiroNome(cliente.nome), empresa, textoDesconto(cupom.tipo, cupom.valor), codigo, val];
}
const montarTexto = (modelo, params) => modelo.texto.replace(/\{\{(\d)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');

// Quem recebe: com consentimento, celular valido e sem campanha nos ultimos 7 dias.
async function destinatarios(tenantId, dados) {
  const { clientesDaCampanha } = require('../routes/customers.routes');
  const lista = await clientesDaCampanha(tenantId, dados);
  const recentes = new Set((await pool.query(
    `SELECT DISTINCT customer_id FROM whatsapp_mensagens WHERE tenant_id = $1 AND campanha_id IS NOT NULL AND customer_id IS NOT NULL
       AND situacao IN ('na_fila', 'enviada', 'entregue', 'lida') AND criado_em > now() - ($2 || ' days')::interval`,
    [tenantId, String(DIAS_ENTRE_CAMPANHAS)]
  )).rows.map((r) => r.customer_id));
  const r = { aptos: [], sem_consentimento: 0, sem_celular: 0, recentes: 0 };
  for (const c of lista) {
    if (!c.aceita_mensagens) r.sem_consentimento += 1;
    else if (!wa.telefoneWhatsapp(c.telefone)) r.sem_celular += 1;
    else if (recentes.has(c.id)) r.recentes += 1;
    else r.aptos.push(c);
  }
  return r;
}

async function contaPronta(tenantId) {
  const c = await wa.contaDa(pool, tenantId);
  if (!c || c.status === 'desconectado') throw new HttpError(409, 'conecte o WhatsApp primeiro (menu WhatsApp)');
  if (c.status !== 'conectado') throw new HttpError(409, 'o WhatsApp precisa ser reconectado (menu WhatsApp)');
  return c;
}

// Modelos de marketing e a situacao de cada um na Meta.
async function modelos(tenantId) {
  await wa.garantirModelosMarketing(tenantId);
  const c = await wa.contaDa(pool, tenantId);
  return wa.MODELOS_MARKETING.map((m) => ({
    chave: m.chave, nome: m.nome, titulo: m.titulo, texto: m.texto, rodape: m.rodape, cupom: m.cupom, oferta: !!m.oferta, exemplo: m.exemplo,
    status: (c && (c.modelos || {})[m.nome]) || 'NAO_CRIADO',
  }));
}

async function previa(user, b) {
  const c = await contaPronta(user.tenantId);
  const d = lerCampanha(b);
  const r = await destinatarios(user.tenantId, d);
  const empresa = c.nome_verificado || 'nossa loja';
  const exemploCliente = r.aptos[0] || { nome: 'Maria' };
  const params = parametros(d.modelo, { cliente: exemploCliente, empresa, oferta: d.oferta, cupom: d.cupom, codigo: d.cupom ? codigoCupom(d.cupom.prefixo) : null });
  return {
    total: Math.min(r.aptos.length, MAX_POR_CAMPANHA), acima_do_limite: r.aptos.length > MAX_POR_CAMPANHA,
    sem_consentimento: r.sem_consentimento, sem_celular: r.sem_celular, recentes: r.recentes, dias_entre_campanhas: DIAS_ENTRE_CAMPANHAS,
    custo_estimado: n2(Math.min(r.aptos.length, MAX_POR_CAMPANHA) * custoUnitario()), custo_unitario: custoUnitario(),
    modelo_status: (c.modelos || {})[d.modelo.nome] || 'NAO_CRIADO',
    exemplo: { para: exemploCliente.nome, texto: montarTexto(d.modelo, params), rodape: d.modelo.rodape },
    validade: d.cupom ? dataValidade(d.cupom.validade_dias).curta : null,
    clientes: r.aptos.slice(0, 50).map((x) => ({ id: x.id, nome: x.nome, telefone: x.telefone, dias_ultimo: x.dias_ultimo })),
  };
}

// Cria a campanha: um cupom por cliente + as mensagens na fila (o envio sai aos poucos em enviarFila).
async function criar(user, b) {
  const conta = await contaPronta(user.tenantId);
  const d = lerCampanha(b);
  if ((conta.modelos || {})[d.modelo.nome] !== 'APPROVED') throw new HttpError(409, `o modelo "${d.modelo.titulo}" ainda não foi aprovado pela Meta: aguarde e clique em "Atualizar modelos"`);
  const r = await destinatarios(user.tenantId, d);
  const aptos = r.aptos.slice(0, MAX_POR_CAMPANHA);
  if (aptos.length === 0) throw new HttpError(400, 'nenhum cliente pode receber esta campanha (sem consentimento, sem celular ou já recebeu campanha nos últimos 7 dias)');
  const empresa = conta.nome_verificado || 'nossa loja';
  const val = d.cupom ? dataValidade(d.cupom.validade_dias) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const camp = (await client.query(
      `INSERT INTO whatsapp_campanhas (tenant_id, nome, segmento, modelo, oferta, cupom_tipo, cupom_valor, cupom_pedido_minimo, cupom_validade_dias, cupom_prefixo, total, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [user.tenantId, d.nome, d.segmento, d.modelo.chave, d.oferta, d.cupom ? d.cupom.tipo : null, d.cupom ? d.cupom.valor : null,
        d.cupom ? d.cupom.pedido_minimo : 0, d.cupom ? d.cupom.validade_dias : null, d.cupom ? d.cupom.prefixo : null, aptos.length, user.id]
    )).rows[0];
    for (const cli of aptos) {
      let cupomId = null;
      let codigo = null;
      if (d.cupom) {
        for (let tentativa = 0; tentativa < 6 && !cupomId; tentativa += 1) {
          codigo = codigoCupom(d.cupom.prefixo);
          await client.query('SAVEPOINT cupom');
          try {
            cupomId = (await client.query(
              `INSERT INTO lv_cupons (tenant_id, codigo, descricao, tipo, valor, pedido_minimo, inicio, fim, limite_total, limite_por_cliente, customer_id, campanha_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, $9, $10) RETURNING id`,
              [user.tenantId, codigo, `Campanha WhatsApp: ${d.nome}`, d.cupom.tipo, d.cupom.valor, d.cupom.pedido_minimo, val.inicio, val.fim, cli.id, camp.id]
            )).rows[0].id;
            await client.query('RELEASE SAVEPOINT cupom');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT cupom');
            if (err.code !== '23505') throw err; // codigo repetido: sorteia outro
          }
        }
        if (!cupomId) throw new HttpError(500, 'não foi possível gerar os códigos dos cupons: tente de novo');
      }
      const params = parametros(d.modelo, { cliente: cli, empresa, oferta: d.oferta, cupom: d.cupom, codigo });
      await client.query(
        `INSERT INTO whatsapp_mensagens (tenant_id, evento, telefone, modelo, situacao, campanha_id, customer_id, cupom_id, parametros)
         VALUES ($1, 'campanha', $2, $3, 'na_fila', $4, $5, $6, $7)`,
        [user.tenantId, wa.telefoneWhatsapp(cli.telefone), d.modelo.nome, camp.id, cli.id, cupomId, JSON.stringify(params)]
      );
    }
    await logAudit(client, { tenantId: user.tenantId, usuarioId: user.id, acao: 'whatsapp_campanha_criar', recurso: 'whatsapp_campanhas', recursoId: camp.id,
      detalhes: { nome: d.nome, segmento: d.segmento, modelo: d.modelo.chave, total: aptos.length, cupom: d.cupom } });
    await client.query('COMMIT');
    setImmediate(() => { enviarFila().catch(() => {}); });
    return { id: camp.id, total: aptos.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cancelar(user, id) {
  if (!isUuid(id)) throw new HttpError(400, 'campanha inválida');
  const camp = (await pool.query(`SELECT * FROM whatsapp_campanhas WHERE id = $1 AND tenant_id = $2`, [id, user.tenantId])).rows[0];
  if (!camp) throw new HttpError(404, 'campanha não encontrada');
  if (camp.status !== 'enviando') throw new HttpError(409, 'esta campanha já terminou');
  const r = await pool.query(
    `UPDATE whatsapp_mensagens SET situacao = 'ignorada', motivo = 'campanha cancelada', atualizado_em = now() WHERE campanha_id = $1 AND situacao = 'na_fila' RETURNING cupom_id`, [id]
  );
  const cupons = r.rows.map((x) => x.cupom_id).filter(Boolean);
  if (cupons.length) await pool.query(`UPDATE lv_cupons SET ativo = false WHERE id = ANY($1::uuid[])`, [cupons]);
  await pool.query(`UPDATE whatsapp_campanhas SET status = 'cancelada', concluida_em = now() WHERE id = $1`, [id]);
  await logAudit(pool, { tenantId: user.tenantId, usuarioId: user.id, acao: 'whatsapp_campanha_cancelar', recurso: 'whatsapp_campanhas', recursoId: id, detalhes: { nao_enviadas: r.rows.length } });
  return { ok: true, nao_enviadas: r.rows.length };
}

// Resultado de cada campanha: envio (Meta) e uso dos cupons (pedidos nao cancelados).
const SQL_RESULTADO = `
  SELECT c.id, c.nome, c.segmento, c.modelo, c.oferta, c.cupom_tipo, c.cupom_valor, c.cupom_pedido_minimo, c.cupom_validade_dias, c.status, c.total, c.criado_em, c.concluida_em,
         u.nome AS criado_por_nome,
         COUNT(m.id) FILTER (WHERE m.situacao = 'na_fila')::int AS na_fila,
         COUNT(m.id) FILTER (WHERE m.situacao IN ('enviada', 'entregue', 'lida'))::int AS enviadas,
         COUNT(m.id) FILTER (WHERE m.situacao IN ('entregue', 'lida'))::int AS entregues,
         COUNT(m.id) FILTER (WHERE m.situacao = 'lida')::int AS lidas,
         COUNT(m.id) FILTER (WHERE m.situacao = 'falhou')::int AS falhas,
         COUNT(m.id) FILTER (WHERE m.situacao = 'ignorada')::int AS ignoradas,
         COALESCE(us.usados, 0)::int AS cupons_usados, COALESCE(us.vendas, 0) AS vendas
  FROM whatsapp_campanhas c
  LEFT JOIN users u ON u.id = c.criado_por
  LEFT JOIN whatsapp_mensagens m ON m.campanha_id = c.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS usados,
           SUM(COALESCE((SELECT SUM(oi.subtotal) FROM order_items oi WHERE oi.order_id = o.id), 0) + o.taxa_entrega - o.desconto) AS vendas
    FROM orders o JOIN lv_cupons cp ON cp.id = o.cupom_id WHERE cp.campanha_id = c.id AND o.status <> 'cancelado'
  ) us ON true
  WHERE c.tenant_id = $1`;

async function lista(tenantId) {
  const { rows } = await pool.query(`${SQL_RESULTADO} GROUP BY c.id, u.nome, us.usados, us.vendas ORDER BY c.criado_em DESC LIMIT 100`, [tenantId]);
  return rows.map((r) => ({ ...r, cupom_valor: r.cupom_valor === null ? null : Number(r.cupom_valor), cupom_pedido_minimo: Number(r.cupom_pedido_minimo), vendas: n2(r.vendas) }));
}

async function detalhe(tenantId, id) {
  if (!isUuid(id)) throw new HttpError(400, 'campanha inválida');
  const { rows } = await pool.query(`${SQL_RESULTADO} AND c.id = $2 GROUP BY c.id, u.nome, us.usados, us.vendas`, [tenantId, id]);
  if (!rows[0]) throw new HttpError(404, 'campanha não encontrada');
  const msgs = (await pool.query(
    `SELECT m.id, m.telefone, m.situacao, m.motivo, m.atualizado_em, cu.nome AS cliente, cp.codigo AS cupom, cp.fim::text AS cupom_fim,
            EXISTS (SELECT 1 FROM orders o WHERE o.cupom_id = cp.id AND o.status <> 'cancelado') AS cupom_usado
     FROM whatsapp_mensagens m LEFT JOIN customers cu ON cu.id = m.customer_id LEFT JOIN lv_cupons cp ON cp.id = m.cupom_id
     WHERE m.campanha_id = $1 ORDER BY cu.nome NULLS LAST LIMIT ${MAX_POR_CAMPANHA}`, [id]
  )).rows;
  const r = rows[0];
  return { ...r, cupom_valor: r.cupom_valor === null ? null : Number(r.cupom_valor), cupom_pedido_minimo: Number(r.cupom_pedido_minimo), vendas: n2(r.vendas), mensagens: msgs };
}

// ---------- envio da fila ----------
const enviando = {}; // um por banco (producao / teste)
async function enviarFila() {
  const ctx = pool.emTeste() ? 't' : 'p';
  if (enviando[ctx]) return 0;
  enviando[ctx] = true;
  let n = 0;
  try {
    // reserva um lote (cada mensagem sai uma vez so, mesmo com mais de um servidor)
    const { rows } = await pool.query(
      `UPDATE whatsapp_mensagens m SET situacao = 'enviada', motivo = 'enviando', atualizado_em = now()
       WHERE m.id IN (SELECT id FROM whatsapp_mensagens WHERE situacao = 'na_fila' ORDER BY criado_em LIMIT ${POR_VEZ} FOR UPDATE SKIP LOCKED)
       RETURNING m.id, m.tenant_id, m.telefone, m.modelo, m.parametros, m.customer_id, m.campanha_id`
    );
    for (const m of rows) {
      const falhar = (motivo, situacao = 'falhou') => pool.query(`UPDATE whatsapp_mensagens SET situacao = $2, motivo = $3, atualizado_em = now() WHERE id = $1`, [m.id, situacao, motivo]);
      try {
        const conta = await wa.contaDa(pool, m.tenant_id);
        if (!conta || conta.status !== 'conectado') { await falhar('WhatsApp desconectado'); continue; }
        if (!(await wa.moduloLigado(m.tenant_id))) { await falhar('módulo WhatsApp desligado', 'ignorada'); continue; }
        const cli = m.customer_id ? (await pool.query(`SELECT aceita_mensagens FROM customers WHERE id = $1`, [m.customer_id])).rows[0] : null;
        if (cli && !cli.aceita_mensagens) { await falhar('cliente não aceita mais mensagens', 'ignorada'); continue; }
        const modelo = wa.MODELOS_MARKETING.find((x) => x.nome === m.modelo);
        const r = await wa.enviarModelo(conta, m.telefone, modelo, m.parametros || []);
        await pool.query(`UPDATE whatsapp_mensagens SET wamid = $2, motivo = NULL, atualizado_em = now() WHERE id = $1`, [m.id, r.wamid]);
        n += 1;
      } catch (err) {
        await falhar(String(err.message).slice(0, 500));
        await wa.marcarErroConta(m.tenant_id, err);
      }
    }
    // campanhas sem nada na fila terminaram
    await pool.query(
      `UPDATE whatsapp_campanhas c SET status = 'concluida', concluida_em = now()
       WHERE c.status = 'enviando' AND NOT EXISTS (SELECT 1 FROM whatsapp_mensagens m WHERE m.campanha_id = c.id AND m.situacao = 'na_fila')`
    );
  } finally {
    enviando[ctx] = false;
  }
  return n;
}

function iniciarEnvio() {
  const seg = Number(process.env.WHATSAPP_CAMPANHA_SEGUNDOS) || 5;
  const t = setInterval(() => { enviarFila().catch((err) => console.error('whatsapp campanha', err.message)); }, seg * 1000);
  if (t.unref) t.unref();
}

module.exports = { modelos, previa, criar, cancelar, lista, detalhe, enviarFila, iniciarEnvio, textoDesconto, DIAS_ENTRE_CAMPANHAS };
