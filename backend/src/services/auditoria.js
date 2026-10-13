// Auditoria global (somente leitura): lista unificada de audit_logs de todas as empresas, com filtros e CSV.
// `tipo` e derivado da `acao` por esta tabela (unica fonte da verdade, usada no filtro SQL e na resposta).
const TIPOS = [
  { codigo: 'login_falha', rotulo: 'Login com falha', acoes: ['login_falha'] },
  { codigo: 'seguranca', rotulo: 'Segurança', acoes: ['trocar_senha', 'redefinir_senha', 'alterar_permissao', 'master_alterar_permissao', 'master_forcar_troca_senha', 'master_encerrar_sessoes', 'resetar_2fa', 'ativar_2fa', 'desativar_2fa', 'bloquear_2fa', 'login_codigo_recuperacao', 'gerar_codigos_recuperacao_2fa', 'exigir_2fa', 'dispensar_2fa'] },
  { codigo: 'suspensao', rotulo: 'Suspensão', acoes: ['master_suspender_empresa', 'master_reativar_empresa'] },
  { codigo: 'config', rotulo: 'Empresas e usuários', acoes: ['master_criar_empresa', 'master_alterar_empresa', 'master_criar_usuario'], prefixos: ['master_config', 'master_aviso', 'master_plano'] },
  { codigo: 'modo_teste', rotulo: 'Modo teste', acoes: ['ligar_modo_teste', 'desligar_modo_teste', 'copiar_producao_para_teste'] },
  { codigo: 'suporte', rotulo: 'Suporte', prefixos: ['master_suporte'] },
  { codigo: 'backup', rotulo: 'Backups e dados', prefixos: ['master_backup', 'master_exportar', 'master_restaurar', 'master_corrigir', 'master_otimizar'] },
  { codigo: 'venda', rotulo: 'Venda', acoes: ['venda'] },
  { codigo: 'cancelamento', rotulo: 'Cancelamento', acoes: ['cancelar_venda', 'cancelar_pedido'] },
  { codigo: 'pedido', rotulo: 'Pedido', acoes: ['criar_pedido', 'pedido_status', 'alterar_destino_pedido'] },
  { codigo: 'caixa', rotulo: 'Caixa', acoes: ['abrir_caixa', 'fechar_caixa'] },
  { codigo: 'estoque', rotulo: 'Estoque', acoes: ['entrada_estoque', 'saida_estoque', 'transferencia', 'balanco_estoque', 'balanco', 'editar_insumo'] },
  { codigo: 'cliente', rotulo: 'Clientes', acoes: ['criar_cliente', 'mesclar_clientes', 'importar_clientes', 'fila_mensagens'] },
  { codigo: 'cadastro', rotulo: 'Cadastros', acoes: ['criar', 'editar', 'excluir'] },
];
const OUTROS = { codigo: 'outros', rotulo: 'Outros' };

function tipoDaAcao(acao) {
  for (const t of TIPOS) {
    if ((t.acoes || []).includes(acao) || (t.prefixos || []).some((p) => String(acao).startsWith(p))) return t;
  }
  return OUTROS;
}

// Condicao SQL (sobre a coluna a.acao) para um tipo; `params` recebe os valores (placeholders $n).
function condicaoDoTipo(codigo, params) {
  const lista = (t) => {
    const partes = [];
    if (t.acoes && t.acoes.length) { params.push(t.acoes); partes.push(`a.acao = ANY($${params.length}::text[])`); }
    for (const p of t.prefixos || []) { params.push(`${p}%`); partes.push(`a.acao LIKE $${params.length}`); }
    return partes;
  };
  if (codigo === 'outros') {
    const todas = TIPOS.flatMap(lista);
    return todas.length ? `NOT (${todas.join(' OR ')})` : 'true';
  }
  const t = TIPOS.find((x) => x.codigo === codigo);
  if (!t) return 'false';
  return `(${lista(t).join(' OR ')})`;
}

const CHAVE_SENSIVEL = /senha|password|passwd|token|segredo|secret|hash|totp|jwt|authorization|api[_-]?key|database_url/i;

// Remove (recursivamente) campos sensiveis dos detalhes.
function sanearDetalhes(valor, nivel = 0) {
  if (valor === null || typeof valor !== 'object' || nivel > 6) return valor;
  if (Array.isArray(valor)) return valor.slice(0, 50).map((v) => sanearDetalhes(v, nivel + 1));
  const saida = {};
  for (const [k, v] of Object.entries(valor)) saida[k] = CHAVE_SENSIVEL.test(k) ? '[oculto]' : sanearDetalhes(v, nivel + 1);
  return saida;
}

const POR_PAGINA = 50;
const LIMITE_CSV = 10000;

function montarFiltro(q) {
  const params = [];
  const where = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (q.tipo) where.push(condicaoDoTipo(String(q.tipo), params));
  if (q.empresa_id) { if (!uuid.test(q.empresa_id)) return { vazio: true }; params.push(q.empresa_id); where.push(`a.tenant_id = $${params.length}`); }
  if (q.usuario_id) { if (!uuid.test(q.usuario_id)) return { vazio: true }; params.push(q.usuario_id); where.push(`a.usuario_id = $${params.length}`); }
  if (q.de && /^\d{4}-\d{2}-\d{2}$/.test(q.de)) { params.push(q.de); where.push(`a.criado_em >= $${params.length}::date`); }
  if (q.ate && /^\d{4}-\d{2}-\d{2}$/.test(q.ate)) { params.push(q.ate); where.push(`a.criado_em < ($${params.length}::date + 1)`); }
  if (q.q && String(q.q).trim()) {
    params.push(`%${String(q.q).trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); // % e _ da busca valem literalmente
    const n = params.length;
    where.push(`(a.acao ILIKE $${n} OR a.recurso ILIKE $${n} OR u.nome ILIKE $${n} OR u.email::text ILIKE $${n} OR t.nome ILIKE $${n} OR a.detalhes::text ILIKE $${n})`);
  }
  return { params, where: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

const DE = `FROM audit_logs a LEFT JOIN users u ON u.id = a.usuario_id LEFT JOIN tenants t ON t.id = a.tenant_id`;

function linha(r) {
  const tipo = tipoDaAcao(r.acao);
  return {
    id: r.id, criado_em: r.criado_em, acao: r.acao, tipo: tipo.codigo, tipo_rotulo: tipo.rotulo, recurso: r.recurso, recurso_id: r.recurso_id,
    usuario_id: r.usuario_id, usuario_nome: r.usuario_nome, tenant_id: r.tenant_id, empresa_nome: r.empresa_nome,
    detalhes: sanearDetalhes(r.detalhes),
  };
}

async function consultarAuditoria(db, query) {
  const f = montarFiltro(query || {});
  const pagina = Math.max(1, parseInt((query || {}).pagina, 10) || 1);
  if (f.vazio) return { itens: [], pagina, por_pagina: POR_PAGINA, total: 0, paginas: 1 };
  const total = Number((await db.query(`SELECT COUNT(*) AS n ${DE} ${f.where}`, f.params)).rows[0].n);
  const { rows } = await db.query(
    `SELECT a.id, a.criado_em, a.acao, a.recurso, a.recurso_id, a.usuario_id, a.detalhes, a.tenant_id, u.nome AS usuario_nome, t.nome AS empresa_nome
     ${DE} ${f.where} ORDER BY a.criado_em DESC, a.id DESC LIMIT ${POR_PAGINA} OFFSET ${(pagina - 1) * POR_PAGINA}`,
    f.params
  );
  return { itens: rows.map(linha), pagina, por_pagina: POR_PAGINA, total, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)) };
}

function celula(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita formula em planilha
  return `"${s.replace(/"/g, '""')}"`;
}

// CSV com ";" (Excel em pt-BR), BOM UTF-8 e cabecalhos em portugues; detalhes ja saneados.
async function exportarCsv(db, query) {
  const f = montarFiltro(query || {});
  let rows = [];
  if (!f.vazio) {
    rows = (await db.query(
      `SELECT a.id, a.criado_em, a.acao, a.recurso, a.recurso_id, a.usuario_id, a.detalhes, a.tenant_id, u.nome AS usuario_nome, t.nome AS empresa_nome
       ${DE} ${f.where} ORDER BY a.criado_em DESC, a.id DESC LIMIT ${LIMITE_CSV}`,
      f.params
    )).rows;
  }
  const cab = ['Quando', 'Quem', 'Empresa', 'Tipo', 'Ação', 'Recurso', 'Detalhe'];
  const linhas = rows.map((r) => {
    const l = linha(r);
    return [new Date(l.criado_em).toISOString(), l.usuario_nome || '', l.empresa_nome || '', l.tipo_rotulo, l.acao, l.recurso || '', l.detalhes ? JSON.stringify(l.detalhes) : ''];
  });
  return `﻿${[cab, ...linhas].map((c) => c.map(celula).join(';')).join('\r\n')}\r\n`;
}

module.exports = { TIPOS, tipoDaAcao, sanearDetalhes, consultarAuditoria, exportarCsv };
