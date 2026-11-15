-- Pack fechado (faixa "kit"): 12 un por R$ 50,00 sai exatamente R$ 50,00 e o que passa do pack sai pelo preco normal.
-- O preco unitario da linha passa a ser o preco medio com 4 casas (50,00 / 12 = 4,1667); o subtotal continua exato.
ALTER TABLE sale_items ALTER COLUMN preco_unitario TYPE NUMERIC(14,4);
ALTER TABLE order_items ALTER COLUMN preco_unitario TYPE NUMERIC(14,4);
