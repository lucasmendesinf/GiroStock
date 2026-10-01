-- Correcoes da analise de estoque/fornecedores/vendas:
--   * produto com varios fornecedores (product_suppliers)
--   * entrada de estoque com fornecedor, custo e nota fiscal
--   * estoque minimo por local
--   * venda guarda o custo do item e pode ser cancelada (com estorno)
--   * insumos com saldo por local (ingredient_balances)
--   * e-mail de login unico em todo o sistema

-- ---------- Produto x Fornecedor (N:N) ----------
-- products.supplier_id continua existindo como "fornecedor principal".
CREATE TABLE product_suppliers (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, supplier_id)
);
CREATE INDEX idx_product_suppliers_tenant_supplier ON product_suppliers(tenant_id, supplier_id);

INSERT INTO product_suppliers (tenant_id, product_id, supplier_id)
SELECT tenant_id, id, supplier_id FROM products WHERE supplier_id IS NOT NULL;

-- ---------- Entrada de estoque com fornecedor / custo / NF ----------
ALTER TABLE stock_movements ADD COLUMN supplier_id UUID REFERENCES suppliers(id);
ALTER TABLE stock_movements ADD COLUMN custo_unitario NUMERIC(12,4);
ALTER TABLE stock_movements ADD COLUMN documento_fiscal TEXT;
ALTER TABLE stock_movements ADD COLUMN sale_id UUID REFERENCES sales(id);
-- Vendas antigas registravam a saida so com o motivo "Venda <id>": liga ao id da venda
-- para que o cancelamento consiga estornar tambem essas vendas.
UPDATE stock_movements sm SET sale_id = s.id
FROM sales s
WHERE sm.sale_id IS NULL AND sm.tipo = 'saida' AND s.tenant_id = sm.tenant_id
  AND sm.motivo = 'Venda ' || s.id::text;
CREATE INDEX idx_stock_movements_sale ON stock_movements(sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX idx_stock_movements_supplier ON stock_movements(tenant_id, supplier_id) WHERE supplier_id IS NOT NULL;

-- ---------- Estoque minimo por local ----------
ALTER TABLE stock_balances ADD COLUMN estoque_minimo NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (estoque_minimo >= 0);

-- ---------- Venda: custo do item e cancelamento ----------
ALTER TABLE sale_items ADD COLUMN custo_unitario NUMERIC(12,2);
UPDATE sale_items si SET custo_unitario = p.preco_custo FROM products p WHERE p.id = si.product_id;

ALTER TABLE sales ADD COLUMN cancelado_em TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN cancelado_por UUID REFERENCES users(id);
ALTER TABLE sales ADD COLUMN motivo_cancelamento TEXT;

-- ---------- Insumos por local ----------
CREATE TABLE ingredient_balances (
  ingredient_id UUID NOT NULL REFERENCES ingredients(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  saldo NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  estoque_minimo NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (estoque_minimo >= 0),
  PRIMARY KEY (ingredient_id, location_id)
);
CREATE INDEX idx_ingredient_balances_tenant ON ingredient_balances(tenant_id);

-- O saldo global que ja existia vai para o local da lanchonete (ou, se nao houver,
-- para o local mais antigo da empresa).
INSERT INTO ingredient_balances (ingredient_id, location_id, tenant_id, saldo)
SELECT i.id,
       (SELECT l.id FROM locations l
         WHERE l.tenant_id = i.tenant_id
         ORDER BY (l.nome ILIKE '%lanchonete%') DESC, l.criado_em, l.id
         LIMIT 1),
       i.tenant_id,
       i.estoque_atual
FROM ingredients i
WHERE i.estoque_atual > 0
  AND EXISTS (SELECT 1 FROM locations l WHERE l.tenant_id = i.tenant_id);

ALTER TABLE ingredients DROP COLUMN estoque_atual;

ALTER TABLE ingredient_consumptions ADD COLUMN location_id UUID REFERENCES locations(id);
UPDATE ingredient_consumptions ic SET location_id = s.location_id
FROM sale_items si JOIN sales s ON s.id = si.sale_id
WHERE si.id = ic.sale_item_id;

-- ---------- E-mail de login unico no sistema todo ----------
-- O login nao informa a empresa, entao o mesmo e-mail em duas empresas era ambiguo.
DO $$
BEGIN
  IF EXISTS (SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Existem usuarios com o mesmo e-mail em empresas diferentes. Ajuste os e-mails antes de aplicar esta migration.';
  END IF;
END $$;
DROP INDEX uq_users_tenant_email;
CREATE UNIQUE INDEX uq_users_email ON users(email);
