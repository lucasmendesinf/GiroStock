-- Numero de pedido (comanda) por loja e configuracao do cupom/comanda de cada loja.
-- O numero do pedido reinicia quando um caixa e aberto numa loja sem nenhum outro caixa aberto
-- (inicio de um novo turno de trabalho), e nao pela virada do dia.
ALTER TABLE locations ADD COLUMN usa_comanda BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE locations ADD COLUMN cupom_config JSONB;
ALTER TABLE sales ADD COLUMN numero_pedido INTEGER;

CREATE TABLE location_order_counters (
  location_id UUID PRIMARY KEY REFERENCES locations(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  ultimo INTEGER NOT NULL DEFAULT 0
);
