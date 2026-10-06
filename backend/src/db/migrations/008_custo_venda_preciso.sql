-- Custo do item vendido com mais casas decimais: lanches com insumos baratos por grama
-- (ex.: 0,0035 por g) nao perdem centavos no relatorio de custo/lucro.
ALTER TABLE sale_items ALTER COLUMN custo_unitario TYPE NUMERIC(14,4);
