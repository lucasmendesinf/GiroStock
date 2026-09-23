-- Custo por unidade do insumo (ex: R$/g), usado para compor o custo fracionado
-- de produtos com ficha tecnica (ex: 150g de uma peca de queijo de 1kg).
ALTER TABLE ingredients ADD COLUMN custo_unitario NUMERIC(14,6) NOT NULL DEFAULT 0;
