-- Pedido de dinheiro ja pago: guarda o valor entregue pelo cliente (para o troco ao finalizar).
ALTER TABLE orders ADD COLUMN valor_recebido NUMERIC(12,2);
