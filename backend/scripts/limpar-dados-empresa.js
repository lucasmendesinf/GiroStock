// Limpa os dados operacionais de UMA empresa (a do e-mail informado), mantendo lojas/PDVs, usuarios e insumos.
//   LIMPAR_EMAIL=contato@empresa.com npm run limpar-dados-empresa             -> SIMULACAO (nada e gravado)
//   LIMPAR_EMAIL=contato@empresa.com CONFIRMAR=APAGAR npm run limpar-dados-empresa -> backup + limpeza real
// Apaga: vendas, caixa, pedidos, comandas, produtos (e grades, combos, precos, conversoes), clientes, fornecedores, compras,
//   estoque/movimentacoes, financeiro (titulos), comissoes, loja virtual (produtos/categorias/clientes/pagamentos), historicos.
// Mantem: empresa, lojas, PDVs/caixas, usuarios (e permissoes/2FA), insumos (com estoque ZERADO), configuracoes
//   (fiscal, integracoes, categorias e contas financeiras, regioes e cupons da loja virtual, entregadores, auditoria).
// Tudo numa unica transacao: qualquer falha desfaz tudo. Nao toca em nenhuma outra empresa.
require('dotenv').config();
const pool = require('../src/db/pool');
const { tabelasEmOrdem } = require('../src/services/copiaProducao');
const backup = require('../src/services/backup');

// Tabelas (com tenant_id) que NAO sao apagadas.
const MANTER = new Set([
  'users', 'user_locations', 'locations', 'terminals', 'cash_registers', 'ingredients', 'ingredient_balances', 'audit_logs', 'avisos_empresa', 'couriers',
  'fin_categorias', 'fin_contas', 'fin_formas_recebimento', 'comissao_regras', 'integracoes_delivery', 'lv_lojas', 'lv_regioes',
  'lv_cupons', 'sessoes_suporte', 'tenants',
]);

async function run() {
  const email = (process.env.LIMPAR_EMAIL || '').trim();
  if (!email) throw new Error('informe LIMPAR_EMAIL com o e-mail do usuário da empresa');
  const real = process.env.CONFIRMAR === 'APAGAR';
  const u = (await pool.query(`SELECT u.tenant_id, t.nome FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email::text) = lower($1)`, [email])).rows[0];
  if (!u) throw new Error(`nenhum usuário com o e-mail ${email}`);
  const tenant = u.tenant_id;
  console.log(`Empresa: ${u.nome} (${tenant}) — modo: ${real ? 'APAGAR DE VERDADE' : 'SIMULAÇÃO'}`);

  if (real) {
    const b = await backup.gerarBackup({ tipo: 'manual' });
    if (!b || b.status !== 'concluido') throw new Error('backup falhou, nada foi apagado: ' + (b && b.erro));
    console.log(`Backup gerado: ${b.arquivo} (${b.tamanho_bytes} bytes)`);
  }

  const c = await pool.producao.connect();
  try {
    const ordem = (await tabelasEmOrdem(c)).reverse(); // filhos antes dos pais
    const comTenant = new Set((await c.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'`)).rows.map((r) => r.table_name));
    await c.query('BEGIN');
    const total = {};
    for (const t of ordem) {
      if (MANTER.has(t) || !comTenant.has(t)) continue; // tabelas sem tenant_id saem em cascata dos pais
      const r = await c.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenant]);
      if (r.rowCount > 0) total[t] = r.rowCount;
    }
    const z = await c.query(`UPDATE ingredient_balances SET saldo = 0 WHERE tenant_id = $1 AND saldo <> 0`, [tenant]);
    if (z) total['ingredient_balances (zerados)'] = z.rowCount;
    console.table(total);
    // Conferencia: nada de produto/venda/cliente/fornecedor deve sobrar.
    for (const t of ['products', 'sales', 'orders', 'customers', 'suppliers', 'stock_movements', 'cash_sessions']) {
      const n = Number((await c.query(`SELECT count(*) AS n FROM "${t}" WHERE tenant_id = $1`, [tenant])).rows[0].n);
      if (n !== 0) throw new Error(`sobraram ${n} registros em ${t}; tudo desfeito`);
    }
    if (real) { await c.query('COMMIT'); console.log('Limpeza concluída.'); }
    else { await c.query('ROLLBACK'); console.log('Simulação: nada foi gravado. Para apagar, rode de novo com CONFIRMAR=APAGAR.'); }
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { c.release(); }
  await pool.end();
}

run().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
