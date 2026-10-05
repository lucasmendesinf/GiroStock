-- Balanco de estoque de produto: o saldo da loja e substituido pela contagem fisica e a
-- diferenca fica no historico (stock_movements). A quantidade do movimento guarda o valor
-- absoluto da diferenca; saldo_anterior/saldo_novo guardam o antes e o depois.
ALTER TYPE stock_move_type ADD VALUE IF NOT EXISTS 'balanco';

ALTER TABLE stock_movements ADD COLUMN saldo_anterior NUMERIC(14,3);
ALTER TABLE stock_movements ADD COLUMN saldo_novo NUMERIC(14,3);
