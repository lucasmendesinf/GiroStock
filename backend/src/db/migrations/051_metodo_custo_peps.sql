-- Metodo de custo do estoque por empresa: 'medio' (custo medio ponderado, o que ja existia) ou 'peps' (primeiro que entra, primeiro que sai).
-- No PEPS cada entrada vira um LOTE (por produto e por loja) e cada baixa consome o lote mais antigo; o custo da venda (CMV) e o dos lotes consumidos.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS metodo_custo TEXT NOT NULL DEFAULT 'medio' CHECK (metodo_custo IN ('medio', 'peps'));

CREATE TABLE IF NOT EXISTS stock_lotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  entrada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  quantidade_inicial NUMERIC(14,3) NOT NULL CHECK (quantidade_inicial > 0),
  saldo NUMERIC(14,3) NOT NULL CHECK (saldo >= 0),
  custo_unitario NUMERIC(14,4) NOT NULL CHECK (custo_unitario >= 0),
  origem TEXT NOT NULL DEFAULT 'entrada',
  movimento_id UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sale_items ALTER COLUMN custo_unitario TYPE NUMERIC(14,4);

CREATE INDEX IF NOT EXISTS idx_stock_lotes_fila ON stock_lotes(tenant_id, product_id, location_id, entrada_em, criado_em) WHERE saldo > 0;
