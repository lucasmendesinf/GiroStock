// Importa insumos (nome, unidade, custo e saldo por loja) de um arquivo JSON para UMA empresa. Uso tipico: levar o cadastro do
// ambiente local para a producao. Casa por nome + unidade (sem diferenciar maiusculas): se ja existe, ATUALIZA custo e saldos;
// se nao existe, cria. Por padrao so SIMULA (nao grava nada); para gravar: IMPORTAR_CONFIRMAR=SIM.
//   ARQUIVO=dados-importacao/insumos.json [IMPORTAR_CONFIRMAR=SIM] npm run importar-insumos
// Formato do arquivo: { "mapaLojas": { "<loja de origem>": "<loja de destino>" },
//                      "insumos": [ { "nome", "unidade", "custo_unitario", "saldos": { "<loja de origem>": numero } } ] }
// A empresa de destino e a que tem TODAS as lojas de destino (se houver mais de uma empresa assim, o script para e avisa).
// Nao imprime senhas nem segredos; grava uma linha de auditoria (importar_insumos).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const { logAudit } = require('../src/utils/audit');

const num = (v) => Number(v);

(async () => {
  const gravar = process.env.IMPORTAR_CONFIRMAR === 'SIM';
  const c = await pool.producao.connect();
  try {
    const arquivo = path.resolve(__dirname, '..', process.env.ARQUIVO || 'dados-importacao/insumos.json');
    const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const mapa = dados.mapaLojas || {};
    const destinos = [...new Set(Object.values(mapa))];
    if (destinos.length === 0 || !Array.isArray(dados.insumos) || dados.insumos.length === 0) throw new Error('arquivo sem mapaLojas ou sem insumos');

    // Empresa de destino: a unica que possui todas as lojas de destino.
    const cand = (await c.query(
      `SELECT l.tenant_id, t.nome AS empresa FROM locations l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.nome = ANY($1) GROUP BY l.tenant_id, t.nome HAVING COUNT(DISTINCT l.nome) = $2`, [destinos, destinos.length]
    )).rows;
    if (cand.length !== 1) throw new Error(`não achei uma única empresa com as lojas ${destinos.join(' e ')} (encontradas: ${cand.map((x) => x.empresa).join(', ') || 'nenhuma'})`);
    const { tenant_id: tenantId, empresa } = cand[0];
    const lojas = Object.fromEntries((await c.query(`SELECT id, nome FROM locations WHERE tenant_id = $1 AND nome = ANY($2)`, [tenantId, destinos])).rows.map((l) => [l.nome, l.id]));
    console.log(`Empresa de destino: ${empresa} | lojas: ${destinos.join(', ')} | modo: ${gravar ? 'GRAVAR' : 'SIMULAÇÃO (nada será gravado)'}`);

    await c.query('BEGIN');
    const resumo = { criados: 0, atualizados: 0, saldos: 0 };
    for (const i of dados.insumos) {
      const existente = (await c.query(
        `SELECT id, custo_unitario FROM ingredients WHERE tenant_id = $1 AND lower(nome) = lower($2) AND unidade = $3 ORDER BY ativo DESC LIMIT 1`, [tenantId, i.nome, i.unidade]
      )).rows[0];
      let id;
      if (existente) {
        id = existente.id;
        await c.query(`UPDATE ingredients SET custo_unitario = $1, ativo = true WHERE id = $2`, [num(i.custo_unitario), id]);
        resumo.atualizados += 1;
      } else {
        id = (await c.query(`INSERT INTO ingredients (tenant_id, nome, unidade, custo_unitario) VALUES ($1, $2, $3, $4) RETURNING id`, [tenantId, i.nome, i.unidade, num(i.custo_unitario)])).rows[0].id;
        resumo.criados += 1;
      }
      const linhas = [];
      for (const [origem, saldo] of Object.entries(i.saldos || {})) {
        const destino = mapa[origem];
        if (!destino || !lojas[destino]) continue;
        const antes = (await c.query(`SELECT saldo FROM ingredient_balances WHERE ingredient_id = $1 AND location_id = $2`, [id, lojas[destino]])).rows[0];
        await c.query(
          `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo, estoque_minimo) VALUES ($1, $2, $3, $4, 0)
           ON CONFLICT (ingredient_id, location_id) DO UPDATE SET saldo = EXCLUDED.saldo`, [id, lojas[destino], tenantId, num(saldo)]
        );
        resumo.saldos += 1;
        linhas.push(`${destino}: ${antes ? num(antes.saldo) : '—'} → ${num(saldo)}`);
      }
      console.log(` ${existente ? 'atualiza' : 'cria    '} ${i.nome} (${i.unidade}) custo ${num(i.custo_unitario)}${linhas.length ? ' | ' + linhas.join(' | ') : ''}`);
    }
    if (gravar) {
      await logAudit(c, { tenantId, usuarioId: null, acao: 'importar_insumos', recurso: 'ingredients', detalhes: { ...resumo, arquivo: path.basename(arquivo) } });
      await c.query('COMMIT');
      console.log(`GRAVADO: ${resumo.criados} criado(s), ${resumo.atualizados} atualizado(s), ${resumo.saldos} saldo(s).`);
    } else {
      await c.query('ROLLBACK');
      console.log(`SIMULAÇÃO concluída (nada gravado): ${resumo.criados} a criar, ${resumo.atualizados} a atualizar, ${resumo.saldos} saldo(s). Para gravar: IMPORTAR_CONFIRMAR=SIM.`);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERRO (nada foi gravado):', e.message);
    process.exitCode = 1;
  }
  c.release();
  await pool.producao.end().catch(() => {});
})();
