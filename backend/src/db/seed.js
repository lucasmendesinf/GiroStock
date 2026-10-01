require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenant = await client.query(
      `INSERT INTO tenants (nome) VALUES ($1) RETURNING id`,
      ['JA Conveniencia']
    );
    const tenantId = tenant.rows[0].id;

    const locNames = ['Distribuidora', 'Lanchonete', 'Tabacaria', 'Casa de Eventos'];
    const locations = {};
    for (const nome of locNames) {
      const r = await client.query(
        `INSERT INTO locations (tenant_id, nome) VALUES ($1, $2) RETURNING id`,
        [tenantId, nome]
      );
      locations[nome] = r.rows[0].id;
    }

    // Um PDV (terminal + caixa) para a distribuidora e outro para a lanchonete.
    const pdvs = [['Distribuidora', 'PDV 01'], ['Lanchonete', 'PDV Lanchonete']];
    for (const [local, nome] of pdvs) {
      const terminal = await client.query(
        `INSERT INTO terminals (tenant_id, location_id, nome) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, locations[local], nome]
      );
      await client.query(
        `INSERT INTO cash_registers (tenant_id, terminal_id) VALUES ($1, $2)`,
        [tenantId, terminal.rows[0].id]
      );
    }

    // Niveis de acesso padrao (Administrador, Gerente, Caixa/Operador, ...).
    await client.query(`SELECT girostock_criar_niveis_padrao($1)`, [tenantId]);
    const senhaHash = await bcrypt.hash('admin123', 10);
    await client.query(
      `INSERT INTO users (tenant_id, nome, email, senha_hash, access_level_id, location_id)
       SELECT $1, $2, $3, $4, id, NULL FROM access_levels WHERE tenant_id = $1 AND nome = 'Administrador'`,
      [tenantId, 'Administrador', 'admin@girostock.local', senhaHash]
    );

    const catBebidas = await client.query(
      `INSERT INTO categories (tenant_id, nome) VALUES ($1, 'Bebidas') RETURNING id`, [tenantId]
    );
    const catLanchonete = await client.query(
      `INSERT INTO categories (tenant_id, nome) VALUES ($1, 'Lanchonete') RETURNING id`, [tenantId]
    );
    const catLanches = await client.query(
      `INSERT INTO categories (tenant_id, nome, parent_id) VALUES ($1, 'Lanches', $2) RETURNING id`,
      [tenantId, catLanchonete.rows[0].id]
    );

    const supplier = await client.query(
      `INSERT INTO suppliers (tenant_id, nome, documento, telefone, categoria)
       VALUES ($1, 'Distribuidora Exemplo Ltda', '11222333000181', '4133334444', 'Bebidas')
       RETURNING id`,
      [tenantId]
    );

    const refri = await client.query(
      `INSERT INTO products (tenant_id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda)
       VALUES ($1, 'PRD-0001', 'Refrigerante Lata 350ml', $2, $3, '7891000100103', 'UN', 3.50, 6.00)
       RETURNING id`,
      [tenantId, catBebidas.rows[0].id, supplier.rows[0].id]
    );

    const xburguer = await client.query(
      `INSERT INTO products (tenant_id, codigo_interno, nome, categoria_id, supplier_id, barcode, unidade, preco_custo, preco_venda)
       VALUES ($1, 'PRD-0002', 'X-Burguer', $2, $3, '7891000100202', 'UN', 8.00, 18.00)
       RETURNING id`,
      [tenantId, catLanches.rows[0].id, supplier.rows[0].id]
    );

    await client.query(
      `INSERT INTO stock_balances (product_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, 50)`,
      [refri.rows[0].id, locations['Distribuidora'], tenantId]
    );
    await client.query(
      `INSERT INTO product_suppliers (tenant_id, product_id, supplier_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
      [tenantId, refri.rows[0].id, supplier.rows[0].id, xburguer.rows[0].id]
    );

    // X-Burguer tem ficha tecnica: nao tem estoque proprio, consome os insumos da lanchonete.
    async function insumo(nome, unidade, saldo, custoUnitario) {
      const r = await client.query(
        `INSERT INTO ingredients (tenant_id, nome, unidade, custo_unitario) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, nome, unidade, custoUnitario]
      );
      await client.query(
        `INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo) VALUES ($1, $2, $3, $4)`,
        [r.rows[0].id, locations['Lanchonete'], tenantId, saldo]
      );
      return r;
    }
    const pao = await insumo('Pao', 'UN', 40, 0.8);
    const carne = await insumo('Carne', 'G', 5000, 0.03);
    const bacon = await insumo('Bacon', 'G', 200, 0.05);

    await client.query(
      `INSERT INTO product_ingredients (tenant_id, product_id, ingredient_id, quantidade_por_unidade) VALUES
       ($1, $2, $3, 1), ($1, $2, $4, 150), ($1, $2, $5, 30)`,
      [tenantId, xburguer.rows[0].id, pao.rows[0].id, carne.rows[0].id, bacon.rows[0].id]
    );

    await client.query('COMMIT');
    console.log('seed concluido. login: admin@girostock.local / admin123');
    console.log('tenant_id:', tenantId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
