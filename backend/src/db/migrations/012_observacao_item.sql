-- Observacao do pedido por item (ex.: "sem milho"), usada em lanches com receita.
ALTER TABLE sale_items ADD COLUMN observacao TEXT;
