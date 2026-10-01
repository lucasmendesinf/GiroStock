-- Melhorias de UX:
--   * numero curto e sequencial da venda por empresa (Venda no 1234) em vez do UUID
--   * desconto na venda (subtotal - desconto = total)

ALTER TABLE sales ADD COLUMN numero INTEGER;
UPDATE sales s SET numero = x.n
FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY criado_em, id) AS n FROM sales) x
WHERE x.id = s.id;
ALTER TABLE sales ALTER COLUMN numero SET NOT NULL;
CREATE UNIQUE INDEX uq_sales_tenant_numero ON sales(tenant_id, numero);

ALTER TABLE sales ADD COLUMN subtotal NUMERIC(12,2);
UPDATE sales SET subtotal = total;
ALTER TABLE sales ALTER COLUMN subtotal SET NOT NULL;
ALTER TABLE sales ADD COLUMN desconto NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (desconto >= 0);
ALTER TABLE sales ADD CONSTRAINT chk_sales_desconto CHECK (desconto < subtotal);
