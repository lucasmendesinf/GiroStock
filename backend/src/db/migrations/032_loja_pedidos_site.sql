-- Pedidos do site no fluxo de loja online (varejo): gerenciados na Loja virtual (aba Pedidos do site), sem o modulo
-- Pedidos. Etapas (as mesmas colunas do pedido): novo -> em_preparo (em separacao) -> pronto (embalado / pronto para
-- retirada) -> saiu_entrega (enviado, com rastreio) -> finalizado (entregue/retirado).
-- lv_fluxo: 'cardapio' = vai para a tela de Pedidos (cozinha); 'ecommerce' = loja online. Pedido de fora do site: NULL.
ALTER TABLE orders ADD COLUMN lv_fluxo TEXT CHECK (lv_fluxo IN ('cardapio', 'ecommerce'));
UPDATE orders SET lv_fluxo = 'cardapio' WHERE origem = 'loja_virtual';
ALTER TABLE orders ADD COLUMN transportadora TEXT;
ALTER TABLE orders ADD COLUMN rastreio_codigo TEXT;
ALTER TABLE orders ADD COLUMN rastreio_url TEXT;
ALTER TABLE orders ADD COLUMN enviado_em TIMESTAMPTZ;
CREATE INDEX idx_orders_lv_fluxo ON orders(tenant_id, lv_fluxo, status) WHERE lv_fluxo IS NOT NULL;

-- Venda de pedido pago no site: nao passa pelo caixa (o dinheiro nao esta na gaveta), entao sem terminal/sessao de caixa.
ALTER TABLE sales ALTER COLUMN terminal_id DROP NOT NULL;
ALTER TABLE sales ALTER COLUMN cash_session_id DROP NOT NULL;
