-- Combos: margem desejada padrao (sobre o preco de venda) e "terminar o preco sugerido em ,90", por empresa.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS combo_margem_pct NUMERIC(5,2) NOT NULL DEFAULT 30 CHECK (combo_margem_pct >= 0 AND combo_margem_pct < 95);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS combo_preco_final_90 BOOLEAN NOT NULL DEFAULT true;
