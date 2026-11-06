// Nota fiscal (modulo "nota_fiscal"): NFC-e (cupom fiscal eletronico) emitida direto na SEFAZ pelo motor PHP
// (backend/fiscal/motor.php, NFePHP), sem intermediario e sem custo por nota.
// Fluxo: a venda e gravada normalmente; depois, se o caixa escolheu "cupom fiscal", emitirNFCe monta a nota a partir da
// venda (itens, desconto, taxas, pagamentos), reserva o numero, envia e guarda o XML. Sem conexao com a SEFAZ, a nota sai em
// contingencia offline e e transmitida depois (varrerContingencia). Ambiente "homologacao" = notas de TESTE (sem valor fiscal).
const path = require('path');
const { spawn } = require('child_process');
const pool = require('../db/pool');
const { HttpError } = require('../utils/http');
const { cifrar, decifrar } = require('./totp');
const { FUSO } = require('../utils/query');

const DIR_MOTOR = path.join(__dirname, '..', '..', 'fiscal');
const n2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const digitos = (v) => String(v || '').replace(/\D/g, '');
const MODOS = ['desligado', 'perguntar', 'sempre'];
const AMBIENTES = ['homologacao', 'producao'];
const COD_UF = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
// forma de pagamento do GiroStock -> tPag da NFC-e
const T_PAG = { dinheiro: '01', cartao_credito: '03', cartao_debito: '04', pix: '17', online: '99' };

// ---------- motor (PHP) ----------
function chamarMotor(entrada, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const php = process.env.FISCAL_PHP || 'php';
    const p = spawn(php, ['motor.php'], { cwd: DIR_MOTOR, env: { ...process.env } });
    let saida = '';
    let erro = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new HttpError(504, 'o motor fiscal demorou demais para responder')); }, timeoutMs);
    p.stdout.on('data', (d) => { saida += d; });
    p.stderr.on('data', (d) => { erro += d; });
    p.on('error', (err) => { clearTimeout(t); reject(new HttpError(500, `motor fiscal indisponível (${err.code === 'ENOENT' ? 'PHP não encontrado no servidor' : err.message})`)); });
    p.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(saida)); } catch (e) { reject(new HttpError(500, `motor fiscal: resposta inválida ${(erro || saida).slice(0, 300)}`)); }
    });
    p.stdin.end(JSON.stringify(entrada));
  });
}

// ---------- validacoes ----------
function cnpjValido(c) {
  const d = digitos(c);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = base.split('').reduce((t, n, i) => t + Number(n) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(d.slice(0, 12)) === Number(d[12]) && calc(d.slice(0, 13)) === Number(d[13]);
}
function cpfValido(c) {
  const d = digitos(c);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) {
    const s = d.slice(0, n).split('').reduce((t, x, i) => t + Number(x) * (n + 1 - i), 0);
    if (((s * 10) % 11) % 10 !== Number(d[n])) return false;
  }
  return true;
}
const texto = (v, max) => String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);

// ---------- configuracao por loja ----------
async function configDaLoja(db, tenantId, locationId) {
  return (await db.query(`SELECT * FROM fiscal_lojas WHERE location_id = $1 AND tenant_id = $2`, [locationId, tenantId])).rows[0] || null;
}

// O que a tela mostra (sem segredos).
function publica(c, loja) {
  if (!c) return { location_id: loja.id, location_nome: loja.nome, configurada: false, modo_pdv: 'desligado' };
  return {
    location_id: c.location_id, location_nome: loja.nome, configurada: true, ambiente: c.ambiente, modo_pdv: c.modo_pdv,
    cnpj: c.cnpj, ie: c.ie, razao_social: c.razao_social, nome_fantasia: c.nome_fantasia, crt: c.crt, logradouro: c.logradouro, numero: c.numero,
    complemento: c.complemento, bairro: c.bairro, cod_municipio: c.cod_municipio, municipio: c.municipio, uf: c.uf, cep: c.cep, telefone: c.telefone,
    serie_nfce: c.serie_nfce, certificado: c.cert_cript ? { titular: c.cert_titular, validade: c.cert_validade } : null,
    csc_homologacao: !!c.csc_homolog_cript, csc_homolog_id: c.csc_homolog_id, csc_producao: !!c.csc_prod_cript, csc_prod_id: c.csc_prod_id,
    pronta: prontaPara(c),
  };
}
// Falta algo para emitir no ambiente atual?
function pendencias(c) {
  const p = [];
  if (!c) return ['configure os dados fiscais da loja'];
  if (!c.cert_cript) p.push('envie o certificado digital A1 (.pfx)');
  else if (c.cert_validade && new Date(c.cert_validade) < new Date()) p.push('o certificado digital está vencido');
  if (c.ambiente === 'homologacao' && !c.csc_homolog_cript) p.push('informe o CSC de homologação (teste)');
  if (c.ambiente === 'producao' && !c.csc_prod_cript) p.push('informe o CSC de produção');
  return p;
}
const prontaPara = (c) => pendencias(c).length === 0;

async function salvarConfig(client, user, locationId, b) {
  const atual = await configDaLoja(client, user.tenantId, locationId);
  const v = (k, padrao = '') => (b[k] === undefined ? (atual ? atual[k] : padrao) : b[k]);
  const cnpj = digitos(v('cnpj'));
  if (!cnpjValido(cnpj)) throw new HttpError(400, 'CNPJ inválido');
  const ie = digitos(v('ie'));
  if (ie.length < 2) throw new HttpError(400, 'informe a inscrição estadual (só números)');
  const razao = texto(v('razao_social'), 60);
  if (razao.length < 3) throw new HttpError(400, 'informe a razão social');
  const uf = String(v('uf', 'PR')).toUpperCase();
  if (!COD_UF[uf]) throw new HttpError(400, 'UF inválida');
  const codMun = digitos(v('cod_municipio'));
  if (codMun.length !== 7 || !codMun.startsWith(String(COD_UF[uf]))) throw new HttpError(400, `código IBGE do município inválido (7 números, começa com ${COD_UF[uf]} para ${uf}; Curitiba = 4106902)`);
  const cep = digitos(v('cep'));
  if (cep.length !== 8) throw new HttpError(400, 'CEP inválido');
  for (const [k, nome] of [['logradouro', 'logradouro'], ['numero', 'número'], ['bairro', 'bairro'], ['municipio', 'município']]) {
    if (!texto(v(k), 60)) throw new HttpError(400, `informe o ${nome} do endereço`);
  }
  const ambiente = v('ambiente', 'homologacao');
  if (!AMBIENTES.includes(ambiente)) throw new HttpError(400, 'ambiente inválido');
  const modo = v('modo_pdv', 'perguntar');
  if (!MODOS.includes(modo)) throw new HttpError(400, 'modo do PDV inválido');
  const serie = Number(v('serie_nfce', 1));
  if (!Number.isInteger(serie) || serie < 0 || serie > 999) throw new HttpError(400, 'série inválida (0 a 999)');
  const crt = Number(v('crt', 1));
  if (![1, 2, 3, 4].includes(crt)) throw new HttpError(400, 'regime tributário inválido');
  // CSC: so muda quando informado (o valor salvo nunca volta para a tela)
  const cscHom = b.csc_homologacao ? cifrar(texto(b.csc_homologacao, 64)) : atual ? atual.csc_homolog_cript : null;
  const cscProd = b.csc_producao ? cifrar(texto(b.csc_producao, 64)) : atual ? atual.csc_prod_cript : null;
  const idCsc = (k, a) => (b[k] === undefined ? (atual ? atual[a] : null) : digitos(b[k]).padStart(6, '0').slice(-6) || null);
  if (ambiente === 'producao' && atual && atual.ambiente === 'homologacao' && b.confirmar_producao !== true) {
    throw new HttpError(409, 'para passar a emitir notas reais (produção), confirme a mudança');
  }
  await client.query(
    `INSERT INTO fiscal_lojas (location_id, tenant_id, ambiente, modo_pdv, cnpj, ie, razao_social, nome_fantasia, crt, logradouro, numero, complemento, bairro,
                               cod_municipio, municipio, uf, cep, telefone, serie_nfce, csc_homolog_cript, csc_homolog_id, csc_prod_cript, csc_prod_id, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, now())
     ON CONFLICT (location_id) DO UPDATE SET ambiente = $3, modo_pdv = $4, cnpj = $5, ie = $6, razao_social = $7, nome_fantasia = $8, crt = $9, logradouro = $10,
       numero = $11, complemento = $12, bairro = $13, cod_municipio = $14, municipio = $15, uf = $16, cep = $17, telefone = $18, serie_nfce = $19,
       csc_homolog_cript = $20, csc_homolog_id = $21, csc_prod_cript = $22, csc_prod_id = $23, atualizado_em = now()`,
    [locationId, user.tenantId, ambiente, modo, cnpj, ie, razao, texto(v('nome_fantasia'), 60), crt, texto(v('logradouro'), 60), texto(v('numero'), 60),
      texto(v('complemento'), 60), texto(v('bairro'), 60), codMun, texto(v('municipio'), 60), uf, cep, digitos(v('telefone')).slice(0, 14), serie,
      cscHom, idCsc('csc_homolog_id', 'csc_homolog_id'), cscProd, idCsc('csc_prod_id', 'csc_prod_id')]
  );
  return { ambiente, modo_pdv: modo, cnpj };
}

// Certificado A1: confere com o motor (senha certa, validade) antes de guardar cifrado.
async function salvarCertificado(client, user, locationId, { pfx_b64: pfx, senha }) {
  const atual = await configDaLoja(client, user.tenantId, locationId);
  if (!atual) throw new HttpError(400, 'preencha e salve os dados fiscais da loja antes do certificado');
  if (!pfx || typeof pfx !== 'string' || pfx.length > 200000) throw new HttpError(400, 'envie o arquivo do certificado (.pfx ou .p12)');
  const info = await chamarMotor({ acao: 'certificado', pfx_b64: pfx, senha: String(senha || '') });
  if (!info.ok) throw new HttpError(400, /mac verify|senha|password/i.test(info.motivo || '') ? 'senha do certificado incorreta' : `certificado inválido: ${info.motivo}`);
  if (info.vencido) throw new HttpError(400, `o certificado venceu em ${String(info.validade).split('-').reverse().join('/')}`);
  if (info.cnpj && info.cnpj !== atual.cnpj) throw new HttpError(400, `o certificado é do CNPJ ${info.cnpj}, diferente do CNPJ da loja (${atual.cnpj})`);
  await client.query(
    `UPDATE fiscal_lojas SET cert_cript = $2, cert_senha_cript = $3, cert_titular = $4, cert_validade = $5, atualizado_em = now() WHERE location_id = $1`,
    [locationId, cifrar(pfx), cifrar(String(senha || '')), info.titular, info.validade]
  );
  return { titular: info.titular, validade: info.validade };
}

// Configuracao no formato do motor.
function configMotor(c) {
  const hom = c.ambiente === 'homologacao';
  return {
    tpAmb: hom ? 2 : 1, razao: c.razao_social, fantasia: c.nome_fantasia, cnpj: c.cnpj, ie: c.ie, crt: c.crt, uf: c.uf, cUF: COD_UF[c.uf],
    endereco: { xLgr: c.logradouro, nro: c.numero, xCpl: c.complemento, xBairro: c.bairro, cMun: c.cod_municipio, xMun: c.municipio, CEP: c.cep, fone: c.telefone },
    csc: decifrar(hom ? c.csc_homolog_cript : c.csc_prod_cript), cscId: (hom ? c.csc_homolog_id : c.csc_prod_id) || '000001',
    pfx_b64: decifrar(c.cert_cript), senha: decifrar(c.cert_senha_cript),
    respTec: process.env.FISCAL_RESP_TEC_CNPJ ? { CNPJ: digitos(process.env.FISCAL_RESP_TEC_CNPJ), xContato: process.env.FISCAL_RESP_TEC_CONTATO || 'Suporte', email: process.env.FISCAL_RESP_TEC_EMAIL || '', fone: process.env.FISCAL_RESP_TEC_FONE || '' } : null,
  };
}

// ---------- montagem da nota a partir da venda ----------
async function dadosDaVenda(db, tenantId, saleId) {
  const venda = (await db.query(
    `SELECT s.*, (s.criado_em AT TIME ZONE '${FUSO}') AS local FROM sales s WHERE s.id = $1 AND s.tenant_id = $2`, [saleId, tenantId]
  )).rows[0];
  if (!venda) throw new HttpError(404, 'venda não encontrada');
  const itens = (await db.query(
    `SELECT si.quantidade, si.preco_unitario, si.subtotal, p.id AS product_id, p.codigo_interno, p.barcode, p.nome, p.unidade, p.ncm, p.cest,
            COALESCE(pf.id, cf.id, df.id) AS perfil_id, COALESCE(pf.cfop, cf.cfop, df.cfop) AS cfop, COALESCE(pf.csosn, cf.csosn, df.csosn) AS csosn,
            COALESCE(pf.origem, cf.origem, df.origem) AS origem, COALESCE(pf.cst_pis, cf.cst_pis, df.cst_pis) AS cst_pis,
            COALESCE(pf.cst_cofins, cf.cst_cofins, df.cst_cofins) AS cst_cofins
     FROM sale_items si JOIN products p ON p.id = si.product_id
     LEFT JOIN perfis_fiscais pf ON pf.id = p.perfil_fiscal_id
     LEFT JOIN categories c ON c.id = p.categoria_id LEFT JOIN perfis_fiscais cf ON cf.id = c.perfil_fiscal_id
     LEFT JOIN perfis_fiscais df ON df.tenant_id = si.tenant_id AND df.padrao
     WHERE si.sale_id = $1 ORDER BY si.id`, [saleId]
  )).rows;
  let pags = (await db.query(`SELECT forma::text AS forma, valor, valor_recebido, troco FROM sale_payments WHERE sale_id = $1`, [saleId])).rows;
  if (!pags.length) pags = [{ forma: venda.forma_pagamento, valor: venda.total, valor_recebido: venda.valor_recebido, troco: venda.troco }];
  return { venda, itens, pags };
}

// Itens com desconto e acrescimos (taxa de entrega/servico) rateados em centavos; o total da nota fecha com o da venda.
function itensDaNota({ venda, itens }) {
  const faltando = itens.filter((i) => !i.ncm);
  if (faltando.length) throw new HttpError(400, `sem NCM no cadastro: ${faltando.slice(0, 3).map((i) => i.nome).join(', ')}${faltando.length > 3 ? '…' : ''} (Produtos → editar → dados fiscais)`);
  const semPerfil = itens.filter((i) => !i.perfil_id);
  if (semPerfil.length) throw new HttpError(400, `sem perfil fiscal: ${semPerfil.slice(0, 3).map((i) => i.nome).join(', ')} (defina no produto, na categoria ou um perfil padrão)`);
  const bruto = n2(itens.reduce((t, i) => t + Number(i.subtotal), 0));
  const desconto = n2(Math.min(Number(venda.desconto || 0), bruto));
  const outros = n2(Number(venda.total) - (bruto - desconto));
  const ratear = (valor) => {
    if (!(valor > 0)) return itens.map(() => 0);
    let resto = Math.round(valor * 100);
    return itens.map((i, k) => {
      if (k === itens.length - 1) return resto / 100;
      const parte = Math.floor((Math.round(valor * 100) * Number(i.subtotal)) / bruto);
      resto -= parte;
      return parte / 100;
    });
  };
  const descs = ratear(desconto);
  const outs = ratear(Math.max(outros, 0));
  return itens.map((i, k) => ({
    codigo: i.codigo_interno, ean: i.barcode, nome: i.nome, ncm: i.ncm, cest: i.cest, cfop: i.cfop, unidade: i.unidade, qtd: Number(i.quantidade),
    valor_unit: Number(i.subtotal) / Number(i.quantidade), total: Number(i.subtotal), desconto: descs[k], outros: outs[k], orig: i.origem, csosn: i.csosn,
    cst_pis: i.cst_pis, cst_cofins: i.cst_cofins,
  }));
}

function pagamentosDaNota(pags) {
  let troco = 0;
  const lista = pags.filter((p) => Number(p.valor) > 0).map((p) => {
    const tPag = T_PAG[p.forma] || '99';
    const recebido = p.forma === 'dinheiro' && p.valor_recebido !== null && Number(p.valor_recebido) > Number(p.valor) ? Number(p.valor_recebido) : Number(p.valor);
    troco += recebido - Number(p.valor);
    return { tPag, valor: n2(recebido), xPag: tPag === '99' ? 'Pagamento online' : null };
  });
  return { pagamentos: lista, troco: n2(troco) };
}

async function agoraSP(db) {
  return (await db.query(`SELECT to_char(now() AT TIME ZONE '${FUSO}', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00' AS t`)).rows[0].t;
}

async function reservarNumero(tenantId, c) {
  const { rows } = await pool.query(
    `INSERT INTO fiscal_numeracao (tenant_id, cnpj, ambiente, modelo, serie, proximo) VALUES ($1, $2, $3, 65, $4, 2)
     ON CONFLICT (tenant_id, cnpj, ambiente, modelo, serie) DO UPDATE SET proximo = fiscal_numeracao.proximo + 1 RETURNING proximo - 1 AS numero`,
    [tenantId, c.cnpj, c.ambiente, c.serie_nfce]
  );
  return rows[0].numero;
}

const SELECT_NOTA = `SELECT n.id, n.sale_id, n.location_id, n.modelo, n.ambiente, n.serie, n.numero, n.chave, n.situacao, n.cstat, n.motivo, n.protocolo, n.qrcode,
  n.url_consulta, n.cpf, n.valor, n.tentativas, n.emitida_em, n.autorizada_em, n.cancelada_em, n.cancel_justificativa, s.numero AS venda_numero, l.nome AS location_nome
  FROM notas_fiscais n LEFT JOIN sales s ON s.id = n.sale_id JOIN locations l ON l.id = n.location_id`;
async function notaPorId(db, tenantId, id) {
  const r = (await db.query(`${SELECT_NOTA} WHERE n.id = $1 AND n.tenant_id = $2`, [id, tenantId])).rows[0];
  if (!r) throw new HttpError(404, 'nota não encontrada');
  return { ...r, valor: Number(r.valor), teste: r.ambiente === 'homologacao' };
}

// Envia (ou reenvia) a nota: autorizada, rejeitada (motivo da SEFAZ), contingencia (sem conexao) ou erro (dados).
async function transmitirNova(nota, c, dados, extra) {
  const cfg = configMotor(c);
  const montar = async (tpEmis) => ({
    serie: nota.serie, numero: nota.numero, cNF: String(Math.floor(10000000 + Math.random() * 89999999)), dhEmi: await agoraSP(pool),
    tpEmis, dhCont: tpEmis === 9 ? await agoraSP(pool) : undefined, xJust: tpEmis === 9 ? 'Sem comunicacao com a SEFAZ no momento da venda' : undefined,
    cpf: nota.cpf || undefined, itens: dados.itens, pagamentos: dados.pagamentos, troco: dados.troco,
    infCpl: `Venda nº ${dados.vendaNumero} - GiroStock`,
  });
  let r = await chamarMotor({ acao: 'emitir', config: cfg, nota: await montar(1), ...extra });
  if (r.situacao === 'sem_conexao') r = await chamarMotor({ acao: 'emitir', config: cfg, nota: await montar(9), ...extra });
  return r;
}

async function gravarResultado(id, r) {
  const situacao = r.situacao === 'sem_conexao' ? 'contingencia' : ['autorizada', 'contingencia', 'rejeitada'].includes(r.situacao) ? r.situacao : 'erro';
  await pool.query(
    `UPDATE notas_fiscais SET situacao = $2, cstat = $3, motivo = $4, chave = COALESCE($5, chave), protocolo = COALESCE($6, protocolo), xml = COALESCE($7, xml),
       qrcode = COALESCE($8, qrcode), url_consulta = COALESCE($9, url_consulta), tentativas = tentativas + 1,
       autorizada_em = CASE WHEN $2 = 'autorizada' THEN now() ELSE autorizada_em END WHERE id = $1`,
    [id, situacao, r.cStat || null, String(r.motivo || '').slice(0, 500), r.chave || null, r.protocolo || null, r.xml || null, r.qrcode || null, r.url_consulta || null]
  );
}

// Emite a NFC-e de uma venda. Idempotente: venda que ja tem nota valida devolve a mesma nota.
async function emitirNFCe(user, saleId, { cpf, simular } = {}) {
  const dados = await dadosDaVenda(pool, user.tenantId, saleId);
  const { venda } = dados;
  if (venda.status !== 'concluida') throw new HttpError(409, 'só venda concluída gera nota');
  const existente = (await pool.query(
    `SELECT id FROM notas_fiscais WHERE sale_id = $1 AND situacao IN ('processando', 'autorizada', 'contingencia', 'rejeitada', 'erro') ORDER BY emitida_em DESC LIMIT 1`, [saleId]
  )).rows[0];
  if (existente) {
    const n = await notaPorId(pool, user.tenantId, existente.id);
    if (n.situacao === 'rejeitada' || n.situacao === 'erro') return reenviar(user, n.id, { simular });
    return n;
  }
  const c = await configDaLoja(pool, user.tenantId, venda.location_id);
  const falta = pendencias(c);
  if (falta.length) throw new HttpError(400, `nota fiscal não configurada nesta loja: ${falta.join('; ')}`);
  const doc = digitos(cpf);
  if (doc && !cpfValido(doc)) throw new HttpError(400, 'CPF inválido');
  const itens = itensDaNota(dados);   // valida NCM e perfil antes de gastar um numero
  const { pagamentos, troco } = pagamentosDaNota(dados.pags);
  const numero = await reservarNumero(user.tenantId, c);
  const { rows } = await pool.query(
    `INSERT INTO notas_fiscais (tenant_id, location_id, sale_id, modelo, ambiente, cnpj, serie, numero, cpf, valor, emitida_por)
     VALUES ($1, $2, $3, 65, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [user.tenantId, venda.location_id, saleId, c.ambiente, c.cnpj, c.serie_nfce, numero, doc || null, venda.total, user.id]
  );
  const id = rows[0].id;
  let r;
  try {
    r = await transmitirNova({ serie: c.serie_nfce, numero, cpf: doc }, c, { itens, pagamentos, troco, vendaNumero: venda.numero }, simular ? { simular } : {});
  } catch (err) {
    r = { situacao: 'erro', motivo: err.message };
  }
  await gravarResultado(id, r);
  return notaPorId(pool, user.tenantId, id);
}

// Reenvia nota rejeitada ou com erro (ex.: depois de corrigir o NCM), com o mesmo numero.
async function reenviar(user, id, { simular } = {}) {
  const n = await notaPorId(pool, user.tenantId, id);
  if (!['rejeitada', 'erro'].includes(n.situacao)) {
    if (n.situacao === 'contingencia') { await transmitirContingencia(id, { simular }); return notaPorId(pool, user.tenantId, id); }
    throw new HttpError(409, 'esta nota não precisa ser reenviada');
  }
  const c = await configDaLoja(pool, user.tenantId, n.location_id);
  const falta = pendencias(c);
  if (falta.length) throw new HttpError(400, falta.join('; '));
  if (c.ambiente !== n.ambiente || c.serie_nfce !== n.serie) throw new HttpError(409, 'o ambiente ou a série da loja mudou: emita uma nota nova para a venda');
  const dados = await dadosDaVenda(pool, user.tenantId, n.sale_id);
  let r;
  try {
    const itens = itensDaNota(dados);
    const { pagamentos, troco } = pagamentosDaNota(dados.pags);
    r = await transmitirNova({ serie: n.serie, numero: n.numero, cpf: n.cpf }, c, { itens, pagamentos, troco, vendaNumero: dados.venda.numero }, simular ? { simular } : {});
  } catch (err) {
    r = { situacao: 'erro', motivo: err.message };
  }
  await gravarResultado(id, r);
  return notaPorId(pool, user.tenantId, id);
}

// Nota emitida em contingencia: envia o mesmo XML assinado.
async function transmitirContingencia(id, { simular } = {}) {
  const n = (await pool.query(`SELECT * FROM notas_fiscais WHERE id = $1 AND situacao = 'contingencia'`, [id])).rows[0];
  if (!n) return null;
  const c = await configDaLoja(pool, n.tenant_id, n.location_id);
  if (!c || !c.cert_cript) return null;
  const r = await chamarMotor({ acao: 'transmitir', config: configMotor({ ...c, ambiente: n.ambiente }), xml: n.xml, ...(simular ? { simular } : {}) });
  if (r.situacao === 'sem_conexao') {
    await pool.query(`UPDATE notas_fiscais SET tentativas = tentativas + 1, motivo = $2 WHERE id = $1`, [id, 'Aguardando conexão com a SEFAZ para enviar']);
    return 'contingencia';
  }
  await gravarResultado(id, r);
  return r.situacao;
}

async function cancelar(user, id, justificativa, { simular } = {}) {
  const n = await notaPorId(pool, user.tenantId, id);
  if (n.situacao === 'contingencia') throw new HttpError(409, 'a nota ainda não foi enviada à SEFAZ (contingência): aguarde a conexão e tente de novo');
  if (n.situacao !== 'autorizada') throw new HttpError(409, 'só nota autorizada pode ser cancelada');
  const just = texto(justificativa, 255);
  if (just.length < 15) throw new HttpError(400, 'a justificativa do cancelamento precisa ter ao menos 15 letras');
  const c = await configDaLoja(pool, user.tenantId, n.location_id);
  const r = await chamarMotor({ acao: 'cancelar', config: configMotor({ ...c, ambiente: n.ambiente }), chave: n.chave, protocolo: n.protocolo, justificativa: just, ...(simular ? { simular } : {}) });
  if (!r.ok) throw new HttpError(422, `a SEFAZ recusou o cancelamento: ${r.motivo}`);
  await pool.query(`UPDATE notas_fiscais SET situacao = 'cancelada', cancelada_em = now(), cancel_justificativa = $2, cancel_protocolo = $3 WHERE id = $1`, [id, just, r.protocolo || null]);
  return notaPorId(pool, user.tenantId, id);
}

// Varredura: envia as notas de contingencia (a cada FISCAL_VARREDURA_SEGUNDOS, padrao 120).
let varrendo = false;
async function varrerContingencia() {
  if (varrendo) return;
  varrendo = true;
  try {
    const { rows } = await pool.query(`SELECT id FROM notas_fiscais WHERE situacao = 'contingencia' ORDER BY emitida_em LIMIT 20`);
    for (const r of rows) { try { await transmitirContingencia(r.id); } catch (err) { /* tenta na proxima rodada */ } }
  } finally {
    varrendo = false;
  }
}
function iniciarVarredura() {
  const seg = Number(process.env.FISCAL_VARREDURA_SEGUNDOS) || 120;
  const t = setInterval(() => { varrerContingencia().catch(() => {}); }, seg * 1000);
  if (t.unref) t.unref();
}

module.exports = {
  chamarMotor, cnpjValido, cpfValido, configDaLoja, publica, pendencias, salvarConfig, salvarCertificado, configMotor, emitirNFCe, reenviar, cancelar,
  transmitirContingencia, varrerContingencia, iniciarVarredura, notaPorId, SELECT_NOTA, MODOS, T_PAG,
};
